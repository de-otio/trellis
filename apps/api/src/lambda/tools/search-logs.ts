import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const cwl = new CloudWatchLogsClient({ region: process.env.AWS_REGION });
const STAGE = process.env.STAGE!;
const APP_NAME = process.env.APP_NAME || "trellis";
const LOG_GROUP = process.env.LOG_GROUP || `/${APP_NAME}/${STAGE}/api`;
const MAX_MINUTES = 120;
const MAX_POLL_ITERATIONS = 10;
const POLL_DELAY_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const handler = async (event: {
  query?: string;
  minutes?: number;
}) => {
  const minutes = Math.min(event.minutes ?? 30, MAX_MINUTES);
  let query = event.query ?? `fields @timestamp, @message | sort @timestamp desc | limit 50`;

  // Enforce a limit clause to prevent runaway queries
  if (!/\|\s*limit\b/i.test(query)) {
    query += " | limit 100";
  }

  const now = Date.now();
  const startTime = Math.floor((now - minutes * 60 * 1000) / 1000);
  const endTime = Math.floor(now / 1000);

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

  // Poll for results
  for (let i = 0; i < MAX_POLL_ITERATIONS; i++) {
    await sleep(POLL_DELAY_MS);

    const result = await cwl.send(
      new GetQueryResultsCommand({ queryId }),
    );

    if (result.status === "Complete") {
      return {
        status: "Complete",
        matchCount: result.results?.length ?? 0,
        results: result.results?.map((row) =>
          Object.fromEntries(row.map((f) => [f.field, f.value])),
        ),
        statistics: result.statistics,
      };
    }

    if (result.status === "Failed" || result.status === "Cancelled") {
      throw new Error(`Query ${result.status}`);
    }
  }

  return {
    status: "Timeout",
    queryId,
    message: `Query still running after ${MAX_POLL_ITERATIONS} poll attempts. Use queryId to check later.`,
  };
};
