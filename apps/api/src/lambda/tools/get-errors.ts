import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const cwl = new CloudWatchLogsClient({ region: process.env.AWS_REGION });
const STAGE = process.env.STAGE!;
const APP_NAME = process.env.APP_NAME || "trellis";
const LOG_GROUP = process.env.LOG_GROUP || `/${APP_NAME}/${STAGE}/api`;
const MAX_POLL_ITERATIONS = 10;
const POLL_DELAY_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const handler = async (event: { minutes?: number }) => {
  const minutes = Math.min(event.minutes ?? 60, 120);
  const now = Date.now();
  const startTime = Math.floor((now - minutes * 60 * 1000) / 1000);
  const endTime = Math.floor(now / 1000);

  const query = `
    fields @timestamp, @message
    | filter @message like /ERROR/
    | stats count(*) as errorCount by @message
    | sort errorCount desc
    | limit 20
  `.trim();

  const { queryId } = await cwl.send(
    new StartQueryCommand({
      logGroupName: LOG_GROUP,
      startTime,
      endTime,
      queryString: query,
    }),
  );

  if (!queryId) {
    throw new Error("Failed to start CloudWatch Logs Insights query");
  }

  for (let i = 0; i < MAX_POLL_ITERATIONS; i++) {
    await sleep(POLL_DELAY_MS);

    const result = await cwl.send(
      new GetQueryResultsCommand({ queryId }),
    );

    if (result.status === "Complete") {
      const rows = result.results ?? [];
      let totalErrors = 0;
      const topErrors: { message: string; count: number }[] = [];

      for (const row of rows) {
        const fields = Object.fromEntries(row.map((f) => [f.field, f.value]));
        const count = parseInt(fields.errorCount ?? "0", 10);
        totalErrors += count;
        topErrors.push({
          message: fields["@message"] ?? "unknown",
          count,
        });
      }

      return {
        errorCount: totalErrors,
        topErrors,
        periodMinutes: minutes,
      };
    }

    if (result.status === "Failed" || result.status === "Cancelled") {
      throw new Error(`Query ${result.status}`);
    }
  }

  throw new Error("Query timed out after polling");
};
