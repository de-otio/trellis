import {
  SNSClient,
  PublishCommand,
} from "@aws-sdk/client-sns";

const sns = new SNSClient({ region: process.env.AWS_REGION });
const ALERT_TOPIC_ARN = process.env.ALERT_TOPIC_ARN!;

export const handler = async (event: {
  subject: string;
  message: string;
}) => {
  const { subject, message } = event;

  if (!subject || !message) {
    throw new Error("subject and message are required");
  }

  const result = await sns.send(
    new PublishCommand({
      TopicArn: ALERT_TOPIC_ARN,
      Subject: subject.slice(0, 100),
      Message: message,
      MessageAttributes: {
        source: {
          DataType: "String",
          StringValue: "agent",
        },
      },
    }),
  );

  return {
    messageId: result.MessageId,
    sent: true,
  };
};
