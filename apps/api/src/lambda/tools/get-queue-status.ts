import {
  SQSClient,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
} from "@aws-sdk/client-sqs";

const sqs = new SQSClient({ region: process.env.AWS_REGION });
const STAGE = process.env.STAGE!;

const QUEUE_NAMES = [
  "delete-account",
  "media-processing",
  "media-reconciliation",
  "link-check",
  "followers-events",
];

async function getQueueAttributes(queueName: string) {
  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: queueName }),
  );

  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
      ],
    }),
  );

  return {
    visible: parseInt(Attributes?.ApproximateNumberOfMessages ?? "0", 10),
    inFlight: parseInt(Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0", 10),
  };
}

export const handler = async () => {
  const results = await Promise.all(
    QUEUE_NAMES.map(async (name) => {
      const queueName = `${STAGE}-${name}`;
      const dlqName = `${STAGE}-${name}-dlq`;

      const [main, dlq] = await Promise.all([
        getQueueAttributes(queueName),
        getQueueAttributes(dlqName),
      ]);

      return {
        name,
        visible: main.visible,
        inFlight: main.inFlight,
        dlqDepth: dlq.visible,
      };
    }),
  );

  return { queues: results };
};
