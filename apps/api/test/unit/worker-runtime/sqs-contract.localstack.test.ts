/**
 * T7a LocalStack contract lane — the same finding-3 gates against a REAL
 * SQS implementation (LocalStack from docker-compose.yml, or Scaleway
 * MNQ-SQS in a scheduled profile run).
 *
 * OPT-IN: set WORKER_SQS_CONTRACT_ENDPOINT (e.g. http://localhost:4566).
 * Skipped otherwise — the deterministic FakeQueue suites in this directory
 * are the always-on gates; this lane proves the transport mapping
 * (visibility timeout, receive count, delete) against real SQS semantics.
 */

import { describe, expect, it } from "vitest";
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { makeSqsQueueClient } from "../../../../worker/src/sqs-queue-client.js";
import { dispatchMessage } from "../../../../worker/src/dispatch.js";
import type { Logger } from "../../../src/lib/logger.js";

const ENDPOINT = process.env.WORKER_SQS_CONTRACT_ENDPOINT;

const logger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

describe.skipIf(!ENDPOINT)("SQS contract (LocalStack)", () => {
  const client = new SQSClient({
    endpoint: ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

  async function freshQueue(visibilitySeconds: number): Promise<string> {
    const name = `ws2-contract-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const res = await client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: { VisibilityTimeout: String(visibilitySeconds) },
      }),
    );
    return res.QueueUrl!;
  }

  async function messageCounts(queueUrl: string): Promise<{ visible: number; inFlight: number }> {
    const res = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
        ],
      }),
    );
    return {
      visible: Number(res.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  }

  it("throw → no-ack: the message survives (redelivers after visibility timeout)", async () => {
    const queueUrl = await freshQueue(1);
    await client.send(
      new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ a: 1 }) }),
    );
    const q = makeSqsQueueClient(client, { queueUrl });

    const [m] = await q.receive({ maxMessages: 1, waitTimeSeconds: 1 });
    expect(m).toBeDefined();
    const out = await dispatchMessage(
      q,
      "contract",
      async () => {
        throw new Error("fail closed");
      },
      m,
      logger,
    );
    expect(out.disposition).toBe("fail");

    // Redelivered after the 1s visibility timeout, with an advanced count.
    await new Promise((r) => setTimeout(r, 1500));
    const [again] = await q.receive({ maxMessages: 1, waitTimeSeconds: 2 });
    expect(again).toBeDefined();
    expect(again.receiveCount).toBe(2);
  });

  it("ack deletes; ack-drop deletes; fail leaves in flight", async () => {
    const queueUrl = await freshQueue(30);
    for (const n of [1, 2, 3]) {
      await client.send(
        new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ n }) }),
      );
    }
    const q = makeSqsQueueClient(client, { queueUrl });
    const dispositions: Record<number, "ack" | "ack-drop" | "fail"> = {
      1: "ack",
      2: "ack-drop",
      3: "fail",
    };
    for (let i = 0; i < 3; i++) {
      const [m] = await q.receive({ maxMessages: 1, waitTimeSeconds: 2 });
      const n = (JSON.parse(m.body) as { n: 1 | 2 | 3 }).n;
      await dispatchMessage(q, "contract", async () => dispositions[n], m, logger);
    }
    const counts = await messageCounts(queueUrl);
    // 1 and 2 deleted; 3 remains in flight.
    expect(counts.visible + counts.inFlight).toBe(1);
  });
});
