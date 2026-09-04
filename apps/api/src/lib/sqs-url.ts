/**
 * Build an SQS / MNQ-SQS queue URL — the ONE convention shared by the request
 * path (`env.ts`) and the worker container (`apps/worker/src/main.ts`), so the
 * two can never drift (a past drift pointed the worker at `{stage}-{queue}`
 * while the real MNQ queues were `{name_prefix}-{stage}-{queue}`).
 *
 * Precedence:
 *   1. `SQS_QUEUE_URL_PREFIX` — an explicit, full prefix INCLUDING the account
 *      segment and any queue-name prefix (e.g. Scaleway MNQ
 *      `{endpoint}/{project-id}/sky-dev-`). The URL is `prefix + queueName`.
 *      This is how the Scaleway deploy points at the real MNQ queue names.
 *   2. Fallback (AWS / LocalStack): `{SQS_ENDPOINT | AWS default}/{AWS_ACCOUNT_ID
 *      | 000000000000}/{stage}-{queueName}`.
 */
export function buildSqsUrl(queueName: string, stage: string): string {
  const prefix = process.env.SQS_QUEUE_URL_PREFIX;
  if (prefix) return `${prefix}${queueName}`;
  const base =
    process.env.SQS_ENDPOINT ||
    `https://sqs.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com`;
  const accountId = process.env.AWS_ACCOUNT_ID || "000000000000";
  return `${base}/${accountId}/${stage}-${queueName}`;
}
