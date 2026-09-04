// Tiny shared PASS/FAIL reporting util so every check-*.ts prints in a
// consistent, greppable format and run-all.ts can build a summary table
// from the same result objects.

export type CheckStatus = "PASS" | "FAIL" | "FINDING";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  evidence: string;
}

export function printResult(result: CheckResult): void {
  const marker =
    result.status === "PASS" ? "✅ PASS" : result.status === "FINDING" ? "🔶 FINDING" : "❌ FAIL";
  console.log(`\n[${marker}] ${result.name}`);
  console.log(`  ${result.evidence.split("\n").join("\n  ")}`);
}

// Wraps a check function so a thrown error becomes a FAIL result instead of
// crashing the whole run — run-all.ts runs checks sequentially and needs
// each one to report cleanly even when the underlying Scaleway call fails.
export async function runCheck(
  name: string,
  fn: () => Promise<Omit<CheckResult, "name">>,
): Promise<CheckResult> {
  try {
    const { status, evidence } = await fn();
    const result: CheckResult = { name, status, evidence };
    printResult(result);
    return result;
  } catch (err) {
    const result: CheckResult = {
      name,
      status: "FAIL",
      evidence: err instanceof Error ? (err.stack ?? err.message) : String(err),
    };
    printResult(result);
    return result;
  }
}

export function printSummaryTable(results: CheckResult[]): void {
  console.log("\n=== G1 Spike Summary ===");
  const nameWidth = Math.max(...results.map((r) => r.name.length), "Check".length);
  const header = `${"Check".padEnd(nameWidth)}  Status`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of results) {
    console.log(`${r.name.padEnd(nameWidth)}  ${r.status}`);
  }
  const failed = results.filter((r) => r.status === "FAIL");
  console.log("");
  if (failed.length === 0) {
    console.log(`All ${results.length} checks completed without a harness failure.`);
    console.log(
      "Note: FINDING entries above are real feasibility results (e.g. presigned-POST support), not bugs — read the Findings section of README.md.",
    );
  } else {
    console.log(`${failed.length}/${results.length} checks FAILED — see evidence above.`);
  }
}
