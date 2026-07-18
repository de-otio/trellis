// check-container.ts
//
// G1 question: does Serverless Containers scale-to-zero (min_scale = 0)
// work as documented, and what's the cold-start latency penalty vs a warm
// request?
//
// Caveat (documented here rather than silently assumed): "cold" in this
// script means "first request this run" — right after `tofu apply`, the
// container has likely never served traffic, so request #1 should reflect
// a genuine cold start. A *second* cold start (after Scaleway scales the
// container back down to zero from idleness) would require waiting out
// Scaleway's idle-scale-down window between requests, which is minutes,
// not something this quick check does automatically. If you want that
// number, rerun `tsx check-container.ts` by hand a few minutes after the
// first `make test` run and compare its "first request" latency to this
// run's warm average.

import { loadOutputs } from "./load-outputs.js";
import { printResult, type CheckResult } from "./report.js";

async function timedGet(url: string): Promise<{ status: number; ms: number }> {
  const start = performance.now();
  const res = await fetch(url);
  await res.text(); // consume body so timing reflects full response, not just headers
  const ms = performance.now() - start;
  return { status: res.status, ms };
}

async function main(): Promise<Omit<CheckResult, "name">> {
  const outputs = loadOutputs();
  const url = outputs.container_public_endpoint;

  const evidence: string[] = [];

  const first = await timedGet(url);
  evidence.push(
    `Request 1 (likely cold, first traffic since apply): HTTP ${first.status}, ${first.ms.toFixed(0)}ms`,
  );

  const warmRuns: { status: number; ms: number }[] = [];
  for (let i = 0; i < 3; i++) {
    warmRuns.push(await timedGet(url));
  }
  const warmAvgMs = warmRuns.reduce((sum, r) => sum + r.ms, 0) / warmRuns.length;
  evidence.push(
    `Requests 2-4 (warm): ${warmRuns.map((r) => `HTTP ${r.status} ${r.ms.toFixed(0)}ms`).join(", ")} — avg ${warmAvgMs.toFixed(0)}ms`,
  );

  const allOk = first.status === 200 && warmRuns.every((r) => r.status === 200);
  const coldMinusWarm = first.ms - warmAvgMs;
  evidence.push(
    `Cold-vs-warm delta: ${coldMinusWarm.toFixed(0)}ms (request 1 minus warm avg). ` +
      `A true repeat-cold-start comparison needs a rerun after Scaleway's idle scale-down window — see comment at top of this file.`,
  );

  return { status: allOk ? "PASS" : "FAIL", evidence: evidence.join("\n") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((result) => {
      printResult({ name: "check-container", ...result });
      process.exit(result.status === "PASS" ? 0 : 1);
    })
    .catch((err) => {
      printResult({
        name: "check-container",
        status: "FAIL",
        evidence: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      process.exit(1);
    });
}

export { main as checkContainer };
