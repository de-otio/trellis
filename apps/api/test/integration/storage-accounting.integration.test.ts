/**
 * Integration Test: the shared storage-accounting invariant (T15 ⇄ T16).
 *
 * Pins the ONE object-state predicate both the per-tenant quota (T16) and the
 * lifecycle guardrails (T15) derive from — see
 * doc/02-technical/operations/storage-accounting.md and
 * src/lib/media/storage-accounting.ts — against a REAL Postgres, exercising
 * all four invariant cases:
 *
 *   1. upload → APPROVE            ⇒ counts against quota (bucket 1)
 *   2. upload → QUARANTINE         ⇒ does NOT count (bucket 2, TTL'd)
 *   3. delete (soft)               ⇒ frees quota immediately; the row falls
 *                                    into the nightly hard-delete scope after
 *                                    N = 7 days
 *   4. abandoned session           ⇒ never counted; reclaimed by the
 *                                    stale-media reap after X = 24 h
 *
 * Opt-in: set STORAGE_TEST_DATABASE_URL to a Postgres with the trellis schema
 * migrated (e.g. the local docker dev DB). Skipped otherwise.
 *
 *   STORAGE_TEST_DATABASE_URL=postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev \
 *     npm run test:integration -- test/integration/storage-accounting.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  quotaUsageWhere,
  hasOtherLiveCasReference,
} from "../../src/lib/media/storage-accounting.js";
import {
  reviewRateWhere,
} from "../../src/lib/media/review-rate-cap.js";
import {
  staleMediaReapCutoff,
  staleMediaReapWhere,
} from "../../src/lib/media/stale-media-reap.js";
import { resolveQuotaLimits } from "../../src/lib/media/quota-resolution.js";
import { checkUploadQuota } from "../../src/lib/media/quota-check.js";

const TEST_DB_URL = process.env.STORAGE_TEST_DATABASE_URL;
const suite = TEST_DB_URL ? describe : describe.skip;

const TENANT = "t-storacct-itest";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

suite("storage-accounting invariant (T15 ⇄ T16)", () => {
  let prisma: PrismaClient;
  let seq = 0;

  /** Deterministic per-run unique hash (content_hash is unique per tenant). */
  const hash = () =>
    `${"a".repeat(56)}${String(seq++).padStart(8, "0")}`;

  const mediaData = (over: Record<string, unknown>) => ({
    tenantId: TENANT,
    mimeType: "video/mp4",
    size: 1_000,
    contentHash: hash(),
    ...over,
  });

  /** The tenant's quota usage exactly as BOTH upload gates read it. */
  async function usage(): Promise<{ objects: number; bytes: number }> {
    const where = quotaUsageWhere(TENANT);
    const [count, sum] = await Promise.all([
      prisma.mediaFile.count({ where }),
      prisma.mediaFile.aggregate({ where, _sum: { size: true } }),
    ]);
    return { objects: count, bytes: sum._sum.size ?? 0 };
  }

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DB_URL! }),
    });
    // Clean slate; tenant cascade clears prior media rows.
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: {
        id: TENANT,
        slug: TENANT,
        displayName: TENANT,
        type: "ORGANIZATION",
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.$disconnect();
  });

  it("case 1 — an APPROVED upload counts against the quota", async () => {
    const before = await usage();
    await prisma.mediaFile.create({
      data: mediaData({ lifecycle: "APPROVED", size: 12_345 }),
    });
    const after = await usage();
    expect(after.objects).toBe(before.objects + 1);
    expect(after.bytes).toBe(before.bytes + 12_345);
  });

  it("case 2 — a QUARANTINED upload does NOT count, but is bounded by the review-rate cap (bucket 2)", async () => {
    const before = await usage();
    await prisma.mediaFile.create({
      data: mediaData({ lifecycle: "QUARANTINED", size: 999_999 }),
    });

    // Not a single byte or object lands on the user's quota…
    const after = await usage();
    expect(after.objects).toBe(before.objects);
    expect(after.bytes).toBe(before.bytes);

    // …but the object IS visible to the review-rate cap that bounds bucket 2
    // (its staging bytes are reclaimed by the consumer's processing/ S3
    // lifecycle rule — 30 days; asserted in the skybber synth test).
    const flagged = await prisma.mediaFile.count({
      where: reviewRateWhere(TENANT, new Date(Date.now() - DAY_MS)),
    });
    expect(flagged).toBeGreaterThanOrEqual(1);

    // And the quota verdict the gates would produce is unchanged by it: with
    // a 1-object / 20 KiB override the APPROVED row (12 345 B) fills the
    // quota, the quarantined 999 999 B does not.
    const limits = resolveQuotaLimits(
      { storageQuotaBytes: BigInt(20_480), storageQuotaObjects: 1 },
      { maxObjects: 1000, maxBytes: 1 << 30 },
    );
    const verdict = checkUploadQuota(
      { currentObjects: after.objects, currentBytes: after.bytes },
      100,
      limits,
    );
    expect(verdict).toEqual({ allowed: false, reason: "object-cap" });
  });

  it("case 3 — soft-delete frees quota IMMEDIATELY; the row enters the nightly hard-delete scope after N = 7 days", async () => {
    const row = await prisma.mediaFile.create({
      data: mediaData({ lifecycle: "APPROVED", size: 50_000 }),
    });
    const withRow = await usage();

    // Soft-delete, back-dated 8 days so the N = 7 day window has elapsed.
    const eightDaysAgo = new Date(Date.now() - 8 * DAY_MS);
    await prisma.mediaFile.update({
      where: { id: row.id },
      data: { deletedAt: eightDaysAgo },
    });

    // Quota freed in the same instant (the aggregate excludes the row).
    const afterDelete = await usage();
    expect(afterDelete.objects).toBe(withRow.objects - 1);
    expect(afterDelete.bytes).toBe(withRow.bytes - 50_000);

    // The soft-deleted row no longer holds a live CAS reference, so the GC
    // may reclaim the bytes (the shared reference-counting predicate).
    expect(
      await hasOtherLiveCasReference(prisma, TENANT, row.contentHash!, []),
    ).toBe(false);

    // The nightly cron's purge scope (nightly-cron.ts step 1:
    // deletedAt <= now - 7d) picks the row up — execute the same deleteMany
    // and verify the bytes-owning row is hard-gone.
    const deletionCutoff = new Date(Date.now() - 7 * DAY_MS);
    const purged = await prisma.mediaFile.deleteMany({
      where: { tenantId: TENANT, deletedAt: { lte: deletionCutoff } },
    });
    expect(purged.count).toBe(1);
    expect(await prisma.mediaFile.findUnique({ where: { id: row.id } })).toBeNull();
  });

  it("case 4 — an abandoned upload session never counts and is reclaimed by the X = 24 h stale reap", async () => {
    const before = await usage();

    // A presigned session whose bytes never arrived: AWAITING_UPLOAD, born
    // 25 h ago, no moderation job ever attached.
    const abandoned = await prisma.mediaFile.create({
      data: mediaData({
        lifecycle: "AWAITING_UPLOAD",
        size: 777,
        contentHash: null, // video rows have no hash until post-transcode
        uploadId: `stale-itest-${Date.now()}`,
        createdAt: new Date(Date.now() - 25 * HOUR_MS),
      }),
    });

    // Never counted against quota…
    const after = await usage();
    expect(after.objects).toBe(before.objects);
    expect(after.bytes).toBe(before.bytes);

    // …and inside the stale-reap scope (X = 24 h default window). Run the
    // reap exactly as the hourly cron does — where applied to deleteMany.
    const where = staleMediaReapWhere(staleMediaReapCutoff());
    const reaped = await prisma.mediaFile.deleteMany({
      where: { ...where, tenantId: TENANT },
    });
    expect(reaped.count).toBe(1);
    expect(
      await prisma.mediaFile.findUnique({ where: { id: abandoned.id } }),
    ).toBeNull();

    // Union check: a FRESH awaiting-upload row (inside the window) is neither
    // counted nor yet reapable — it sits in bucket 2 awaiting either bytes or
    // the TTL. No state escapes both buckets.
    const fresh = await prisma.mediaFile.create({
      data: mediaData({
        lifecycle: "AWAITING_UPLOAD",
        size: 1,
        contentHash: null,
        uploadId: `fresh-itest-${Date.now()}`,
      }),
    });
    expect((await usage()).objects).toBe(before.objects);
    const reapedFresh = await prisma.mediaFile.deleteMany({
      where: { ...staleMediaReapWhere(staleMediaReapCutoff()), tenantId: TENANT, id: fresh.id },
    });
    expect(reapedFresh.count).toBe(0); // too young to reap
  });

  it("cross-check — the QUARANTINED row is NOT reapable (verdict states await a human, never the reaper)", async () => {
    const where = staleMediaReapWhere(new Date(Date.now() + DAY_MS)); // cutoff in the future
    const wouldReap = await prisma.mediaFile.findMany({
      where: { ...where, tenantId: TENANT },
      select: { lifecycle: true },
    });
    expect(wouldReap.every((r) => r.lifecycle !== "QUARANTINED")).toBe(true);
    expect(wouldReap.every((r) => r.lifecycle !== "APPROVED")).toBe(true);
  });
});
