/**
 * Unit + Property Tests: media/media-upsert.ts and the T9 key round-trip.
 *
 * Covers the T9 invariants:
 * - A within-tenant dedup hit (identical bytes re-uploaded) does NOT mutate the
 *   shared canonical row's ownership (`uploadedBy`) or publish state
 *   (`lifecycle`): the `update` payload is EMPTY (T14 consolidation).
 * - upload→serve round-trip: the key the upload writes (cas/{tenant}/{hash}) is
 *   byte-identical to the key the serve path reads (the stored originalKey).
 *
 * Fast-check is seeded for determinism.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { buildMediaUpsertArgs } from "../../../src/lib/media/media-upsert.js";
import { casKey, isCasKeyError } from "../../../src/lib/media/cas-keys.js";
import {
  ALL_MEDIA_LIFECYCLES,
  type MediaLifecycle,
} from "../../../src/lib/media/media-lifecycle.js";

const FC_SEED = 0x09_5e27;

const TENANT = "ctenant0000000000000000aa";
const HASH = "a".repeat(64);

describe("buildMediaUpsertArgs (T9 dedup safety)", () => {
  const args = buildMediaUpsertArgs({
    tenantId: TENANT,
    contentHash: HASH,
    originalKey: `cas/${TENANT}/${HASH}`,
    mimeType: "image/png",
    size: 123,
    uploadedBy: "cuser000000000000000000aa",
  });

  it("scopes the upsert by the within-tenant unique (tenantId_contentHash)", () => {
    expect(args.where).toEqual({
      tenantId_contentHash: { tenantId: TENANT, contentHash: HASH },
    });
  });

  it("create includes tenantId and the uploader (new row born owned)", () => {
    expect(args.create.tenantId).toBe(TENANT);
    expect(args.create.uploadedBy).toBe("cuser000000000000000000aa");
    expect(args.create.originalKey).toBe(`cas/${TENANT}/${HASH}`);
  });

  it("create does NOT set lifecycle (Prisma @default(AWAITING_UPLOAD) governs)", () => {
    expect("lifecycle" in args.create).toBe(false);
  });

  it("dedup-hit update does NOT overwrite uploadedBy (no ownership takeover)", () => {
    expect("uploadedBy" in args.update).toBe(false);
  });

  it("dedup-hit update does NOT reset lifecycle (no de-publish)", () => {
    expect("lifecycle" in args.update).toBe(false);
  });

  it("dedup-hit update is EMPTY — a dedup hit mutates NOTHING on the canonical row", () => {
    expect(Object.keys(args.update)).toEqual([]);
  });

  it("property: regardless of uploader, the update never carries uploadedBy/lifecycle", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (uploader, mime) => {
          const a = buildMediaUpsertArgs({
            tenantId: TENANT,
            contentHash: HASH,
            originalKey: `cas/${TENANT}/${HASH}`,
            mimeType: mime,
            size: 1,
            uploadedBy: uploader,
          });
          expect("uploadedBy" in a.update).toBe(false);
          expect("lifecycle" in a.update).toBe(false);
          expect(Object.keys(a.update)).toEqual([]);
        },
      ),
      { seed: FC_SEED, numRuns: 300 },
    );
  });
});

describe("buildMediaUpsertArgs — lifecycle passthrough (sync-image verdict)", () => {
  const base = {
    tenantId: TENANT,
    contentHash: HASH,
    originalKey: `cas/${TENANT}/${HASH}`,
    mimeType: "image/jpeg",
    size: 42,
    uploadedBy: "cuser000000000000000000aa",
  } as const;

  it("sets create.lifecycle when the verdict is provided (APPROVED)", () => {
    const args = buildMediaUpsertArgs({ ...base, lifecycle: "APPROVED" });
    expect(args.create.lifecycle).toBe("APPROVED");
  });

  it("omits create.lifecycle when absent (Prisma @default(AWAITING_UPLOAD) stands)", () => {
    const args = buildMediaUpsertArgs({ ...base });
    expect("lifecycle" in args.create).toBe(false);
  });

  it("property: every verdict flows into create but NEVER into update", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...(ALL_MEDIA_LIFECYCLES as MediaLifecycle[])),
        (status) => {
          const args = buildMediaUpsertArgs({ ...base, lifecycle: status });
          // create carries the exact verdict...
          expect(args.create.lifecycle).toBe(status);
          // ...and the dedup-no-takeover invariant holds: update carries neither.
          expect("lifecycle" in args.update).toBe(false);
          expect("uploadedBy" in args.update).toBe(false);
        },
      ),
      { seed: FC_SEED, numRuns: 200 },
    );
  });
});

describe("T9 key round-trip (write == read)", () => {
  // Arbitraries matching the validated charsets (CUID tenant, 64-hex hash).
  const tenantArb = fc
    .string({
      unit: fc.constantFrom(..."0123456789abcdefghijklmnopqrstuvwxyz".split("")),
      minLength: 24,
      maxLength: 24,
    })
    .map((s) => `c${s}`);
  const hashArb = fc.string({
    unit: fc.constantFrom(..."0123456789abcdef".split("")),
    minLength: 64,
    maxLength: 64,
  });

  it("property: the key the upload writes equals the key the serve path reads", () => {
    fc.assert(
      fc.property(tenantArb, hashArb, (tenantId, hash) => {
        // Upload side: bytes written under this key AND stored as originalKey.
        const writtenKey = casKey(tenantId, hash);
        expect(isCasKeyError(writtenKey)).toBe(false);
        // Serve side: reads the stored originalKey verbatim (no re-derivation
        // needed, but if it did re-derive it would land on the same string).
        const storedOriginalKey = writtenKey as string;
        const reDerived = casKey(tenantId, hash);
        expect(storedOriginalKey).toBe(reDerived);
        expect(storedOriginalKey).toBe(`cas/${tenantId}/${hash}`);
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });
});
