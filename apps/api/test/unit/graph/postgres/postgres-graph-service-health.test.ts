/**
 * Unit Tests: PostgresGraphService.healthCheck()
 *
 * The health status is surfaced on a pre-auth-reachable path and gets polled
 * during incidents — exactly when the driver is most likely to throw an error
 * that embeds the DSN (pg's ECONNREFUSED echoes the connection string,
 * Prisma's P1001 names the host). These tests pin that the failure branch
 * never returns credentials or hosts in `GraphHealthStatus.error`.
 */

import { describe, expect, it } from "vitest";
import { PostgresGraphService } from "../../../../src/lib/graph/postgres/postgres-graph-service.js";

function serviceWithFailingDb(error: unknown): PostgresGraphService {
  const prisma = {
    $queryRaw: () => Promise.reject(error),
  } as any;
  return new PostgresGraphService(prisma);
}

describe("PostgresGraphService.healthCheck", () => {
  it("reports healthy with latency when the probe succeeds", async () => {
    const prisma = { $queryRaw: () => Promise.resolve([{ "?column?": 1 }]) } as any;
    const service = new PostgresGraphService(prisma);

    const status = await service.healthCheck();

    expect(status.healthy).toBe(true);
    expect(status.backend).toBe("postgres");
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
    expect(status.error).toBeUndefined();
  });

  it("never leaks a DSN with credentials from a pg connection error", async () => {
    const service = serviceWithFailingDb(
      new Error(
        "connect ECONNREFUSED postgresql://app_user:s3cretpw@db.internal.example:5432/trellis",
      ),
    );

    const status = await service.healthCheck();

    expect(status.healthy).toBe(false);
    expect(status.error).toBeDefined();
    expect(status.error).not.toContain("postgresql://");
    expect(status.error).not.toContain("s3cretpw");
    expect(status.error).not.toContain("app_user");
    expect(status.error).not.toContain("db.internal.example");
    expect(status.error).toContain("[pg-uri-redacted]");
  });

  it("never leaks the host from a Prisma P1001-style error", async () => {
    const service = serviceWithFailingDb(
      new Error("Can't reach database server at `db.internal.example`:`5432`"),
    );

    const status = await service.healthCheck();

    expect(status.healthy).toBe(false);
    expect(status.error).not.toContain("db.internal.example");
    expect(status.error).toContain("[db-host-redacted]");
  });

  it("sanitizes non-Error throwables too", async () => {
    const service = serviceWithFailingDb(
      "postgres://user:hunter2@10.0.0.5/db unreachable",
    );

    const status = await service.healthCheck();

    expect(status.healthy).toBe(false);
    expect(status.error).not.toContain("hunter2");
    expect(status.error).not.toContain("10.0.0.5");
  });
});
