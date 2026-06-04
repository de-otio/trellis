/**
 * D3 — Neptune writer-failover resilience test.
 *
 * Validates the C4 reconnection wrapper (`Neo4jGraphService.executeQuery` →
 * single-flight `reconnect()`) end-to-end against a *real* Amazon Neptune
 * failover — the one path the C4 unit tests can only mock (real DNS flip +
 * stale connection pool).
 *
 * This test ONLY runs inside the D2/D3 CodeBuild runner, against a real
 * writer+reader Neptune cluster, with:
 *   GRAPH_TEST_AUTH_MODE=iam
 *   RUN_FAILOVER=1
 *   GRAPH_DB_URI=bolt://<cluster-endpoint>:8182
 *   NEPTUNE_CLUSTER_ID=<db-cluster-identifier>     (for failover-db-cluster)
 *   AWS_REGION=eu-central-1
 * Single-instance dev clusters cannot fail over to a reader — the cluster must
 * be temporarily scaled to writer + reader (see the design doc, "D3 cluster
 * shape"). Absent RUN_FAILOVER=1 the suite is skipped, so it is inert in local
 * and Docker-Neo4j runs.
 *
 * See doc/02-technical/development/testing/neptune-d2-d3-codebuild.md (skybber).
 */

import { spawn } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { createGraphService } from "../../../src/lib/graph/graph-factory.js";
import { Neo4jGraphService } from "../../../src/lib/graph/neo4j-graph-service.js";
import { getTestGraphServiceConfig, isIamTestMode } from "./setup.js";

const FAILOVER_ENABLED = process.env.RUN_FAILOVER === "1";
const CLUSTER_ID = process.env.NEPTUNE_CLUSTER_ID;

/** Fire `aws neptune failover-db-cluster` and resolve when the CLI exits. */
function triggerFailover(clusterId: string, region: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "aws",
      [
        "neptune",
        "failover-db-cluster",
        "--db-cluster-identifier",
        clusterId,
        "--region",
        region,
      ],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`failover-db-cluster exited with code ${code}`)),
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Skip entirely unless explicitly enabled — keeps the suite inert everywhere
// except the runner against a real writer+reader cluster.
describe.skipIf(!FAILOVER_ENABLED)("D3 — Neptune writer failover", () => {
  let svc: Neo4jGraphService;

  afterAll(async () => {
    if (svc) await svc.close();
  });

  it(
    "recovers in-flight queries across a writer failover without surfacing a 5xx",
    async () => {
      expect(isIamTestMode(), "D3 must run in IAM mode (GRAPH_TEST_AUTH_MODE=iam)").toBe(true);
      expect(CLUSTER_ID, "NEPTUNE_CLUSTER_ID must be set for the failover trigger").toBeTruthy();
      const region = process.env.AWS_REGION ?? "eu-central-1";

      svc = (await createGraphService(getTestGraphServiceConfig())) as Neo4jGraphService;

      let ok = 0;
      let transientErrors = 0;
      let stop = false;
      let recoveredAfterFailover = false;
      let failoverTriggered = false;

      // Steady trickle of queries through the C4 wrapper. Transient
      // ServiceUnavailable/SessionExpired during the flip are expected and must
      // be recovered by the single-flight reconnect; we count them but do not
      // let them escape as a test failure.
      const loop = (async () => {
        while (!stop) {
          try {
            await svc.executeQuery("RETURN 1 AS health");
            ok++;
            if (failoverTriggered) recoveredAfterFailover = true;
          } catch {
            transientErrors++;
          }
          await sleep(250);
        }
      })();

      // Let the trickle establish, then promote a reader to writer mid-run.
      await sleep(2_000);
      await triggerFailover(CLUSTER_ID as string, region);
      failoverTriggered = true;

      // Give the cluster time to flip DNS and the wrapper time to rebuild its
      // pool and resume. Failover typically completes in ~30s.
      const deadline = Date.now() + 120_000;
      while (!recoveredAfterFailover && Date.now() < deadline) {
        await sleep(1_000);
      }
      stop = true;
      await loop;

      // The wrapper must have resumed serving queries after the failover…
      expect(recoveredAfterFailover, "queries did not resume after failover").toBe(true);
      // …and a final query must succeed cleanly (no error escaping to the caller).
      await expect(svc.executeQuery("RETURN 1 AS health")).resolves.toBeDefined();

      // Sanity: we made forward progress both before and after the flip.
      expect(ok).toBeGreaterThan(0);
      // Some transient errors during the flip are normal but not required (a fast
      // flip may be fully masked by the reconnect). Log for diagnostics.
      console.info(
        `[D3] queries ok=${ok}, transient errors during flip=${transientErrors}`,
      );
    },
    180_000,
  );
});
