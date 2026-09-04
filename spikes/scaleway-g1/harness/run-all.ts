// run-all.ts — runs every check in sequence and prints a summary table.
//
// Sequential (not parallel) on purpose: check-sqs and check-s3-presigned
// both write test objects/messages, and running the Postgres/Container
// checks concurrently with them doesn't save meaningful time at this scale
// while making failures harder to read. This harness intentionally uses
// plain AWS SDK v3 clients and node-postgres — not Trellis code — because
// it's testing Scaleway's API compat surface, not our ports.

import { runCheck, printSummaryTable, type CheckResult } from "./report.js";
import { checkPostgres } from "./check-postgres.js";
import { checkS3Presigned } from "./check-s3-presigned.js";
import { checkSqs } from "./check-sqs.js";
import { checkContainer } from "./check-container.js";

async function main(): Promise<void> {
  const results: CheckResult[] = [];

  results.push(await runCheck("check-postgres", checkPostgres));
  results.push(await runCheck("check-s3-presigned", checkS3Presigned));
  results.push(await runCheck("check-sqs", checkSqs));
  results.push(await runCheck("check-container", checkContainer));

  printSummaryTable(results);

  const hardFail = results.some((r) => r.status === "FAIL");
  process.exit(hardFail ? 1 : 0);
}

main().catch((err) => {
  console.error("run-all.ts crashed outside the per-check error handling:", err);
  process.exit(1);
});
