/**
 * Discovery Exposure Counters (item 3 — norm-misperception pre-launch)
 *
 * Aggregate-only instrumentation: records how many times each entity has
 * been served as a recommendation during the current calendar month (UTC).
 * The counters are stored as atomic DynamoDB increments in the existing
 * single table so they can be scanned offline to compute concentration
 * metrics (see apps/api/src/lib/graph/EXPOSURE-METRICS.md).
 *
 * KEY INVARIANTS (LOCKED — do not weaken without an RFC):
 *   1. Counter key encodes ONLY the month bucket and entity id.
 *      No viewer identity, no viewer tenant — ever.
 *   2. Fire-and-forget: recording must never block or fail the response.
 *   3. Failures are observable (stderr structured line + metric name
 *      "exposure.record.failure") — mirror of the audit.emit pattern.
 *
 * Data-minimization rationale:
 *   Per-viewer impression logs are refused, not deferred — see
 *   analysis/enshittification-resistance/04-data-minimization.md and
 *   analysis/algorithmic-norm-misperception/02-prelaunch-actions.md §3.
 */

import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { getLogger } from "./logger.js";

// Mirror exactly how openai-budget.ts obtains its client + table name.
const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
});

const TABLE_NAME = process.env.DYNAMODB_TABLE || `${process.env.STAGE || "dev"}-trellis`;

/**
 * Returns the current UTC month bucket in "yyyy-mm" format.
 * Exported for testability.
 */
export function currentMonthBucket(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Atomically increment the served-recommendation counter for a single entity
 * within the current UTC month bucket.
 *
 * Key shape:  pk = "discexposure:{yyyy-mm}:{entityId}", sk = "v"
 * Update:     ADD #count 1  (creates the item on first write)
 * No TTL:     these are baseline counters; time-resolution is the monthly bucket.
 */
async function incrementExposure(entityId: string): Promise<void> {
  const bucket = currentMonthBucket();
  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: `discexposure:${bucket}:${entityId}` },
        sk: { S: "v" },
      },
      UpdateExpression: "ADD #count :inc",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":inc": { N: "1" } },
    }),
  );
}

/**
 * Record that a page of recommendations was served, incrementing each
 * entity's monthly exposure counter by 1.
 *
 * - Batches politely: parallel Promise.all over the page (≤ 30 items by
 *   handler cap — well within DynamoDB throughput).
 * - Fire-and-forget: callers MUST NOT await this; attach `.catch` at call
 *   site or use `void` to suppress the floating-promise lint warning.
 *   (This function itself is async so callers can optionally await in
 *   tests, but the handler wires it as fire-and-forget.)
 * - Failures are observable but never propagate: a rejection on any
 *   individual increment is caught, logged to stderr, and reported via
 *   the "exposure.record.failure" metric name (grep-able by ops).
 */
export async function recordServedRecommendations(entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;

  await Promise.all(entityIds.map((id) => incrementExposure(id))).catch((err: unknown) => {
    // Observable failure: structured stderr line for ops grep, plus
    // logger.error for the in-process log (mirrors audit-fallback pattern).
    // eslint-disable-next-line no-console -- exposure-fallback line for ops grep
    console.error(
      JSON.stringify({
        exposureRecordFailure: true,
        metric: "exposure.record.failure",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    getLogger().error("[DiscoveryExposure] Failed to record served recommendations", { err });
  });
}
