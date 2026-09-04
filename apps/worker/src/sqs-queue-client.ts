/**
 * sqs-queue-client.ts — the SQS-backed `QueueClient` (WS-2 T7a, §3.2).
 *
 * Works against AWS SQS and Scaleway MNQ-SQS purely by endpoint/credentials
 * configuration (the same `SQS_ENDPOINT`-override convention as trellis's
 * `createDefaultSqsClient`). The consumer side is deployment infrastructure
 * and lives HERE, not in saas-foundation — foundation's `SqsQueue` is
 * producer-only by design.
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import type { QueueClient, ReceivedMessage } from "./dispatch.js";

export interface SqsQueueClientOptions {
  readonly queueUrl: string;
}

export function makeSqsQueueClient(
  client: SQSClient,
  options: SqsQueueClientOptions,
): QueueClient {
  return {
    async receive({ maxMessages, waitTimeSeconds, visibilityTimeoutSeconds }) {
      const res = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: options.queueUrl,
          MaxNumberOfMessages: maxMessages,
          WaitTimeSeconds: waitTimeSeconds,
          ...(visibilityTimeoutSeconds !== undefined && {
            VisibilityTimeout: visibilityTimeoutSeconds,
          }),
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );
      const messages: ReceivedMessage[] = [];
      for (const m of res.Messages ?? []) {
        if (m.Body === undefined || m.ReceiptHandle === undefined) continue;
        messages.push({
          messageId: m.MessageId ?? "",
          receiptHandle: m.ReceiptHandle,
          body: m.Body,
          receiveCount: m.Attributes?.ApproximateReceiveCount
            ? Number(m.Attributes.ApproximateReceiveCount)
            : undefined,
        });
      }
      return messages;
    },

    async deleteMessage(receiptHandle) {
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: options.queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    },

    async changeVisibility(receiptHandle, timeoutSeconds) {
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: options.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: timeoutSeconds,
        }),
      );
    },
  };
}

/** Build the default SQS client (endpoint-overridable, like the producer). */
export function makeDefaultSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION || "us-east-1",
    ...(process.env.SQS_ENDPOINT && { endpoint: process.env.SQS_ENDPOINT }),
  });
}
