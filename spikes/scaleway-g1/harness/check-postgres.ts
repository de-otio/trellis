// check-postgres.ts
//
// G1 question: does Managed PostgreSQL 17 support the extensions Trellis
// needs (PostGIS for geo queries, pg_trgm for fuzzy/trigram search)?
// Per the coverage inventory, PostGIS is NOT OpenTofu-managed on Scaleway —
// there is no `scaleway_rdb_*extension*` resource — so this is deliberately
// a SQL-level runbook step, not an infra bug. This script IS that runbook
// step, run as a feasibility check.
//
// Connects with plain `pg` (node-postgres), no ORM/Prisma layer — this
// tests the database engine's compat surface, not our data-access code.

import { Client } from "pg";
import { loadOutputs } from "./load-outputs.js";
import { printResult, type CheckResult } from "./report.js";

async function main(): Promise<Omit<CheckResult, "name">> {
  const outputs = loadOutputs();

  const client = new Client({
    host: outputs.postgres_host || outputs.postgres_ip,
    port: outputs.postgres_port,
    database: outputs.postgres_database,
    user: outputs.postgres_user,
    password: outputs.postgres_password,
    ssl: { rejectUnauthorized: false }, // Scaleway managed PG requires TLS; spike skips CA pinning
    connectionTimeoutMillis: 15_000,
  });

  const evidenceLines: string[] = [];

  await client.connect();
  evidenceLines.push(`Connected to ${outputs.postgres_host}:${outputs.postgres_port}/${outputs.postgres_database}`);

  const versionRes = await client.query("SELECT version();");
  evidenceLines.push(`PostgreSQL version(): ${versionRes.rows[0].version}`);

  await client.query("CREATE EXTENSION IF NOT EXISTS postgis;");
  const postgisRes = await client.query("SELECT PostGIS_Full_Version();");
  evidenceLines.push(`PostGIS_Full_Version(): ${postgisRes.rows[0].postgis_full_version}`);

  // Real PostGIS query: two geography points ~111km apart at the equator
  // (1 degree of longitude ≈ 111km), ST_DWithin at a 150km radius should
  // be true, at a 50km radius should be false. Exercises the geography
  // type + spatial index function, not just extension presence.
  const dwithinTrue = await client.query(
    `SELECT ST_DWithin(
       ST_MakePoint(0, 0)::geography,
       ST_MakePoint(1, 0)::geography,
       150000
     ) AS within_150km;`,
  );
  const dwithinFalse = await client.query(
    `SELECT ST_DWithin(
       ST_MakePoint(0, 0)::geography,
       ST_MakePoint(1, 0)::geography,
       50000
     ) AS within_50km;`,
  );
  evidenceLines.push(
    `ST_DWithin(0,0 / 1,0, 150km) = ${dwithinTrue.rows[0].within_150km} (expect true), ` +
      `ST_DWithin(..., 50km) = ${dwithinFalse.rows[0].within_50km} (expect false)`,
  );

  await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  const trgmRes = await client.query("SELECT similarity('trellis', 'trelis') AS sim;");
  evidenceLines.push(`pg_trgm similarity('trellis','trelis') = ${trgmRes.rows[0].sim} (expect > 0)`);

  await client.end();

  const dwithinOk = dwithinTrue.rows[0].within_150km === true && dwithinFalse.rows[0].within_50km === false;
  const trgmOk = Number(trgmRes.rows[0].sim) > 0;

  const status = dwithinOk && trgmOk ? "PASS" : "FAIL";

  return { status, evidence: evidenceLines.join("\n") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((result) => {
      printResult({ name: "check-postgres", ...result });
      process.exit(result.status === "PASS" ? 0 : 1);
    })
    .catch((err) => {
      printResult({
        name: "check-postgres",
        status: "FAIL",
        evidence: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      process.exit(1);
    });
}

export { main as checkPostgres };
