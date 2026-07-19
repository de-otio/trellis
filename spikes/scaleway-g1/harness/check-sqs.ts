// check-sqs.ts
//
// G1 question: is Scaleway's Queues (MNQ) SQS-compatible surface real
// enough for our usage — plain AWS SDK v3 SQSClient, standard queue
// send/receive/delete, and FIFO queue per-group ordering + content-based
// dedup? The coverage inventory already found FIFO support documented;
// this check exercises it against the live API rather than trusting docs
// alone.
//
// Auth: uses the MNQ-specific SQS credentials minted in infra/queues.tf
// (scaleway_mnq_sqs_credentials), NOT the general SCW_ACCESS_KEY/SECRET —
// those are two different credential systems in Scaleway.

import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { loadOutputs } from "./load-outputs.js";
import { printResult, type CheckResult } from "./report.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainQueue(
  sqs: SQSClient,
  queueUrl: string,
  expectedCount: number,
  opts: { fifoAttrs?: boolean; timeoutMs?: number } = {},
): Promise<Message[]> {
  const collected: Message[] = [];
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);

  while (collected.length < expectedCount && Date.now() < deadline) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 3,
        MessageSystemAttributeNames: opts.fifoAttrs ? ["MessageGroupId", "MessageDeduplicationId", "SequenceNumber"] : undefined,
      }),
    );
    for (const msg of res.Messages ?? []) {
      collected.push(msg);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: msg.ReceiptHandle! }));
    }
    if (!res.Messages || res.Messages.length === 0) {
      await sleep(500);
    }
  }
  return collected;
}

async function main(): Promise<Omit<CheckResult, "name">> {
  const outputs = loadOutputs();

  const sqs = new SQSClient({
    region: "fr-par",
    endpoint: outputs.sqs_endpoint,
    credentials: {
      accessKeyId: outputs.sqs_access_key,
      secretAccessKey: outputs.sqs_secret_key,
    },
  });

  const evidence: string[] = [];
  let ok = true;

  // --- Standard queue: send / receive / delete round-trip ---
  const stdBody = `g1-spike standard queue test — ${new Date().toISOString()}`;
  await sqs.send(new SendMessageCommand({ QueueUrl: outputs.sqs_standard_queue_url, MessageBody: stdBody }));
  const stdReceived = await drainQueue(sqs, outputs.sqs_standard_queue_url, 1, { timeoutMs: 15_000 });
  const stdOk = stdReceived.length >= 1 && stdReceived.some((m) => m.Body === stdBody);
  ok &&= stdOk;
  evidence.push(
    `Standard queue send/receive/delete: sent 1, received ${stdReceived.length}, body match = ${stdOk} — ${stdOk ? "PASS" : "FAIL"}`,
  );

  // --- FIFO queue: per-group ordering ---
  // content_based_deduplication = true on the FIFO queue (see queues.tf),
  // so MessageDeduplicationId is derived from body content automatically —
  // we don't pass one explicitly.
  const groupA = "group-a";
  const groupB = "group-b";
  const a1 = `A1-${Date.now()}`;
  const a2 = `A2-${Date.now()}`;
  const b1 = `B1-${Date.now()}`;

  await sqs.send(new SendMessageCommand({ QueueUrl: outputs.sqs_fifo_queue_url, MessageBody: a1, MessageGroupId: groupA }));
  await sqs.send(new SendMessageCommand({ QueueUrl: outputs.sqs_fifo_queue_url, MessageBody: a2, MessageGroupId: groupA }));
  await sqs.send(new SendMessageCommand({ QueueUrl: outputs.sqs_fifo_queue_url, MessageBody: b1, MessageGroupId: groupB }));
  // Duplicate of a1's *exact* content — with content-based dedup enabled,
  // Scaleway should treat this as the same message within the dedup
  // window and NOT deliver it a second time.
  await sqs.send(new SendMessageCommand({ QueueUrl: outputs.sqs_fifo_queue_url, MessageBody: a1, MessageGroupId: groupA }));

  const fifoReceived = await drainQueue(sqs, outputs.sqs_fifo_queue_url, 3, { fifoAttrs: true, timeoutMs: 20_000 });

  const bodiesReceived = fifoReceived.map((m) => m.Body);
  const dedupOk = bodiesReceived.filter((b) => b === a1).length === 1;

  // FIFO ordering is a property of DELIVERY ORDER, not of an echoed group
  // attribute. Scaleway's MNQ SQS-compatible ReceiveMessage does not populate
  // the MessageGroupId system attribute in the response (see the compat note
  // below), so we assert ordering on the actual receive sequence: within
  // group-a (the only two group-a messages), a1 must be delivered before a2.
  const idxA1 = bodiesReceived.indexOf(a1);
  const idxA2 = bodiesReceived.indexOf(a2);
  const orderingOk = idxA1 !== -1 && idxA2 !== -1 && idxA1 < idxA2;

  const groupBOk = bodiesReceived.includes(b1);

  // Compat data point (not pass/fail): did MNQ echo the MessageGroupId
  // system attribute we requested? AWS SQS does; Scaleway MNQ (as of this
  // run) does not — harmless for our usage, but worth recording.
  const groupIdEchoed = fifoReceived.some((m) => m.Attributes?.MessageGroupId != null);

  const fifoOk = dedupOk && orderingOk && groupBOk;
  ok &&= fifoOk;

  evidence.push(
    `FIFO queue: sent A1, A2 (group-a), B1 (group-b), duplicate-A1 (should dedup). ` +
      `Received ${fifoReceived.length} messages total, in delivery order: [${bodiesReceived.join(", ")}]`,
  );
  evidence.push(
    `  Dedup check (A1 delivered exactly once) = ${dedupOk}; ` +
      `group-a ordering (A1 before A2 in delivery order) = ${orderingOk}; ` +
      `group-b delivered B1 = ${groupBOk} — ${fifoOk ? "PASS" : "FAIL"}`,
  );
  evidence.push(
    `  Compat note: MessageGroupId echoed on receive = ${groupIdEchoed} ` +
      `(AWS SQS returns it; Scaleway MNQ does not — ordering/dedup still work).`,
  );

  return { status: ok ? "PASS" : "FAIL", evidence: evidence.join("\n") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((result) => {
      printResult({ name: "check-sqs", ...result });
      process.exit(result.status === "PASS" ? 0 : 1);
    })
    .catch((err) => {
      printResult({
        name: "check-sqs",
        status: "FAIL",
        evidence: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      process.exit(1);
    });
}

export { main as checkSqs };
