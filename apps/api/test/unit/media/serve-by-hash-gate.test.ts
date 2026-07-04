/**
 * Anti-oracle serve-gate tests for serveMediaByHash (T5).
 *
 * The load-bearing safety suite. Asserts:
 *  - No status !== APPROVED yields bytes to ANY viewer in {owner, other, public}
 *    × mediaType.
 *  - Owner-vs-other never changes the decision (no owner exception).
 *  - EVERY deny branch the gate can emit returns a BYTE-IDENTICAL response:
 *    equal status, the exact enumerated header set, byte-for-byte body. The
 *    branches enumerated here are EXHAUSTIVE w.r.t. serveMediaByHash:
 *      1. invalid inbound hash (rejected before any lookup)
 *      2. no resolved viewer tenant (viewerTenantId === null)
 *      3. not-found (DB returns null)
 *      4. DB-error (query throws)
 *      5. PENDING / REVIEW / QUARANTINED / REJECTED
 *      6. hidden (even when APPROVED)
 *      7. soft-deleted (even when APPROVED)
 *      8. APPROVED but originalKey === null
 *      9. APPROVED + key, but the storage bucket is falsy (misconfig)
 *     10. APPROVED + key + bucket, but bucket.get(...) returns null (bytes gone)
 *  - The deny payload is PINNED to the documented constant `{"error":"Media not
 *    found"}` with EXACTLY {Content-Type, Cache-Control, X-Content-Type-Options}
 *    — no per-request trace_id / tenant hint / state-dependent header may leak.
 *  - Origin-independence: two different Origin headers produce a byte-identical
 *    deny (no media-state-dependent header varies with the viewer/origin).
 *  - Tenant isolation: the DB mock is tenant-AWARE (honours
 *    where.tenantId_contentHash.tenantId); a record owned by another tenant is
 *    NOT served to this viewer — a regression hardcoding a cross-tenant id would
 *    turn red.
 *  - APPROVED serves with Content-Disposition: attachment + canonical
 *    content-type (never object.httpMetadata).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

// --- Mock the I/O edges so only the gate logic is under test ---

// CorsHandler: pass the response through unchanged (no per-request mutation that
// would mask byte-identity). NOTE: the byte-identity assertions below also
// enumerate the EXACT header set, so even if a future CORS shim attached an
// origin-dependent header it would be caught by the "no extra header leaks"
// assertion rather than hidden by this pass-through.
vi.mock("../../../src/lib/cors-handler", () => ({
  CorsHandler: { addCorsHeaders: async (r: Response) => r },
}));

// Logger: silent.
vi.mock("../../../src/lib/logger", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  Logger: class {},
}));

// The single tenant the ambient auth seam resolves for the viewer in this suite.
// The DB mock returns the record ONLY when the query is scoped to this tenant.
const RESOLVED_TENANT = "ctenanttest0000000000001";
const OTHER_TENANT = "cothertenant000000000001";

// db-query-helper: drives the query fn against a per-test-controlled db handle.
// The findUnique mock is TENANT-AWARE: it inspects the where clause's
// `tenantId_contentHash.tenantId` and serves a record only from the matching
// tenant's store. This is what makes tenant isolation a real assertion — a
// regression that hardcoded `tenantId: "global"` (ignoring the viewer's tenant)
// would query the wrong store, miss, and (for the leak test) be caught.
let dbThrows = false;
/** tenantId -> the record findUnique returns for that tenant (null = miss). */
let recordsByTenant: Map<string, any> = new Map();
/** Records every where clause findUnique was actually called with. */
const findUniqueCalls: Array<{ tenantId: string; contentHash: string }> = [];

const mockFindUnique = vi.fn(async (args: any) => {
  const key = args?.where?.tenantId_contentHash;
  // The gate must always scope by the composite unique; a regression that
  // dropped it would hand us `undefined` here and is caught by the call-shape
  // assertions in the dedicated tenant tests.
  findUniqueCalls.push({
    tenantId: key?.tenantId,
    contentHash: key?.contentHash,
  });
  if (!key) return null;
  return recordsByTenant.get(key.tenantId) ?? null;
});

vi.mock("../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: async (
    _mgr: any,
    _region: string,
    _env: any,
    queryFn: (db: any) => Promise<any>,
  ) => {
    if (dbThrows) {
      throw new Error("simulated DB failure");
    }
    return queryFn({ mediaFile: { findUnique: mockFindUnique } });
  },
  QueryTimeoutPresets: { USER_FACING: {} },
}));

vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {},
}));

// Heavy/irrelevant module-level imports of media.ts — stub to keep the import graph light.
vi.mock("../../../src/lib/services/image-normalizer", () => ({
  REENCODABLE_IMAGE_TYPES: new Set<string>(),
  reencodeImage: vi.fn(),
}));
vi.mock("../../../src/lib/media-handler", () => ({
  MediaHandler: { create: vi.fn() },
}));
vi.mock("../../../src/lib/services/media-upload-service", () => ({
  MediaUploadService: class {},
}));

// Ambient tenant present so serveMediaByHash's tenant resolution succeeds and
// the GATE logic (the subject of this suite) is exercised. resolveMediaTenantId
// returns the ambient tenant verbatim, so the resolved viewer tenant is exactly
// RESOLVED_TENANT — which the tenant-aware findUnique store is keyed by. A test
// below overrides this to undefined to drive the no-tenant deny branch.
let ambientTenant: string | undefined = RESOLVED_TENANT;
vi.mock("@de-otio/saas-foundation/tenant", () => ({
  getCurrentTenantId: () => ambientTenant,
}));

import { serveMediaByHash } from "../../../src/lib/routes/media.js";
import {
  ALL_MODERATION_STATUSES,
  type ModerationStatus,
} from "../../../src/lib/media/moderation-status.js";

const VALID_HASH = "a".repeat(64);
const APPROVED_KEY = `cas/${RESOLVED_TENANT}/${VALID_HASH}`;

// The documented, pinned deny contract (T5 anti-oracle). EVERY non-APPROVED
// outcome must equal this exactly — body bytes AND header set. Pinning the
// literal (not just cross-case equality) is what catches a UNIFORM body
// mutation, e.g. adding a per-request `trace_id` or a tenant hint to every deny.
const DENY_BODY = JSON.stringify({ error: "Media not found" });
const DENY_HEADERS: Array<[string, string]> = [
  ["cache-control", "no-store"],
  ["content-type", "application/json"],
  ["x-content-type-options", "nosniff"],
];

// A storage object whose bytes/metadata would leak if the gate were bypassed.
const SECRET_BYTES = new Uint8Array([1, 2, 3, 4, 5]);
function makeBucket() {
  return {
    get: vi.fn(async (_key: string) => ({
      body: SECRET_BYTES,
      httpMetadata: { contentType: "image/svg+xml" }, // must NEVER be used
    })),
  };
}

function makeEnv(bucket: any) {
  return {
    ENVIRONMENT: "dev",
    MEDIA_BUCKET_R2: bucket,
    media: { canonicalFormat: "jpeg" as const },
  };
}

function record(over: Partial<{
  moderationStatus: ModerationStatus;
  hidden: boolean;
  deletedAt: Date | null;
  originalKey: string | null;
}>) {
  return {
    moderationStatus: "PENDING" as ModerationStatus,
    hidden: false,
    deletedAt: null,
    originalKey: APPROVED_KEY,
    ...over,
  };
}

/** Put a record into the viewer's resolved tenant store (the matching tenant). */
function storeForViewer(rec: any) {
  recordsByTenant = new Map([[RESOLVED_TENANT, rec]]);
}

const VIEWERS = [
  { userId: "owner-1" },
  { userId: "other-2" },
  { userId: "public-anon" },
];

/**
 * Snapshot the FULL observable response: status, the sorted enumerated header
 * set, and the body bytes. Used for byte-identity comparisons.
 */
async function snapshot(res: Response) {
  return {
    status: res.status,
    headers: [...res.headers.entries()].sort(),
    body: await res.text(),
  };
}

/** Assert a response is EXACTLY the pinned uniform deny (status+headers+body). */
async function expectPinnedDeny(res: Response) {
  expect(res.status).toBe(404);
  expect(await res.clone().text()).toBe(DENY_BODY);
  // EXACT header set — no extra header (trace id, tenant hint, vary-by-state)
  // may leak. Sorting both sides makes this order-independent but membership-exact.
  expect([...res.headers.entries()].sort()).toEqual(DENY_HEADERS);
}

describe("serveMediaByHash anti-oracle gate (T5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbThrows = false;
    ambientTenant = RESOLVED_TENANT;
    recordsByTenant = new Map(); // default: not-found for every tenant
    findUniqueCalls.length = 0;
  });

  const req = (origin?: string) =>
    new Request(`https://api.example.com/api/media/${VALID_HASH}`, {
      headers: origin ? { Origin: origin } : {},
    });

  it("APPROVED serves bytes with Content-Disposition: attachment + canonical type", async () => {
    const bucket = makeBucket();
    storeForViewer(record({ moderationStatus: "APPROVED" }));

    const res = await serveMediaByHash(
      VALID_HASH,
      "original",
      req(),
      makeEnv(bucket),
      VIEWERS[0],
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
    // Content-type from canonicalFormat ONLY — never the object's svg metadata.
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Type")).not.toContain("svg");
    expect(bucket.get).toHaveBeenCalledWith(APPROVED_KEY);
  });

  it("property: no status !== APPROVED yields bytes to ANY viewer", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ModerationStatus>(...ALL_MODERATION_STATUSES),
        fc.integer({ min: 0, max: VIEWERS.length - 1 }),
        async (status, viewerIdx) => {
          if (status === "APPROVED") return;
          const bucket = makeBucket();
          storeForViewer(record({ moderationStatus: status }));

          const res = await serveMediaByHash(
            VALID_HASH,
            "original",
            req(),
            makeEnv(bucket),
            VIEWERS[viewerIdx],
          );

          await expectPinnedDeny(res);
          expect(bucket.get).not.toHaveBeenCalled();
        },
      ),
      { seed: 0x5e_11_ca_7e, numRuns: 300 },
    );
  });

  it("owner vs other vs public produces an IDENTICAL response for a PENDING object", async () => {
    const snaps = [];
    for (const viewer of VIEWERS) {
      storeForViewer(record({ moderationStatus: "PENDING" }));
      const res = await serveMediaByHash(
        VALID_HASH,
        "original",
        req(),
        makeEnv(makeBucket()),
        viewer,
      );
      snaps.push(await snapshot(res));
    }
    expect(snaps[1]).toEqual(snaps[0]);
    expect(snaps[2]).toEqual(snaps[0]);
  });

  // --- EXHAUSTIVE byte-identity across every deny branch -------------------

  /**
   * One entry per deny branch serveMediaByHash can take. Each entry arranges
   * the mocks, returns the (contentHash, env, viewer) to drive, and the suite
   * asserts (a) every snapshot is byte-identical to the first, and (b) each is
   * the pinned uniform deny. This is the anti-oracle's core: an attacker cannot
   * distinguish absent / not-yet-approved / hidden / deleted / DB-down /
   * no-key / no-bucket / bytes-gone / wrong-tenant / malformed-hash.
   */
  const DENY_BRANCHES: Array<{
    name: string;
    arrange: () => { hash: string; env: any; viewer: { userId: string } };
  }> = [
    {
      name: "invalid inbound hash (pre-lookup reject)",
      arrange: () => {
        return { hash: "not-a-valid-hash", env: makeEnv(makeBucket()), viewer: VIEWERS[1] };
      },
    },
    {
      name: "no resolved viewer tenant (viewerTenantId === null)",
      arrange: () => {
        ambientTenant = undefined; // and scope mode is off, no personal fallback wired
        return { hash: VALID_HASH, env: makeEnv(makeBucket()), viewer: VIEWERS[1] };
      },
    },
    {
      name: "not-found (DB null)",
      arrange: () => {
        recordsByTenant = new Map(); // miss
        return { hash: VALID_HASH, env: makeEnv(makeBucket()), viewer: VIEWERS[1] };
      },
    },
    {
      name: "DB-error (query throws)",
      arrange: () => {
        dbThrows = true;
        return { hash: VALID_HASH, env: makeEnv(makeBucket()), viewer: VIEWERS[1] };
      },
    },
    ...(["PENDING", "REVIEW", "QUARANTINED", "REJECTED"] as ModerationStatus[]).map(
      (s) => ({
        name: `non-approved status: ${s}`,
        arrange: () => {
          storeForViewer(record({ moderationStatus: s }));
          return { hash: VALID_HASH, env: makeEnv(makeBucket()), viewer: VIEWERS[1] };
        },
      }),
    ),
    {
      name: "hidden (APPROVED but hidden)",
      arrange: () => {
        storeForViewer(record({ moderationStatus: "APPROVED", hidden: true }));
        return { hash: VALID_HASH, env: makeEnv(makeBucket()), viewer: VIEWERS[1] };
      },
    },
    {
      name: "soft-deleted (APPROVED but deletedAt set)",
      arrange: () => {
        storeForViewer(
          record({ moderationStatus: "APPROVED", deletedAt: new Date(0) }),
        );
        return { hash: VALID_HASH, env: makeEnv(makeBucket()), viewer: VIEWERS[1] };
      },
    },
    {
      name: "APPROVED but originalKey === null",
      arrange: () => {
        storeForViewer(record({ moderationStatus: "APPROVED", originalKey: null }));
        return { hash: VALID_HASH, env: makeEnv(makeBucket()), viewer: VIEWERS[1] };
      },
    },
    {
      name: "APPROVED + key but storage bucket falsy (misconfig)",
      arrange: () => {
        storeForViewer(record({ moderationStatus: "APPROVED" }));
        // No MEDIA_BUCKET_R2 / R2_BUCKET on env -> r2Bucket falsy.
        return {
          hash: VALID_HASH,
          env: { ENVIRONMENT: "dev", media: { canonicalFormat: "jpeg" as const } },
          viewer: VIEWERS[1],
        };
      },
    },
    {
      name: "APPROVED + key + bucket but bucket.get returns null (bytes gone)",
      arrange: () => {
        storeForViewer(record({ moderationStatus: "APPROVED" }));
        const emptyBucket = { get: vi.fn(async (_k: string) => null) };
        return { hash: VALID_HASH, env: makeEnv(emptyBucket), viewer: VIEWERS[1] };
      },
    },
    {
      name: "wrong-tenant record (isolation miss)",
      arrange: () => {
        // An APPROVED, fully-servable record exists — but under ANOTHER tenant.
        // The viewer resolves to RESOLVED_TENANT, so the tenant-scoped lookup
        // misses and denies. (See the dedicated leak test below.)
        recordsByTenant = new Map([
          [OTHER_TENANT, record({ moderationStatus: "APPROVED" })],
        ]);
        return { hash: VALID_HASH, env: makeEnv(makeBucket()), viewer: VIEWERS[1] };
      },
    },
  ];

  it("EVERY deny branch is byte-identical (status + EXACT headers + body) and is the pinned deny", async () => {
    const snaps: Array<Awaited<ReturnType<typeof snapshot>>> = [];
    for (const branch of DENY_BRANCHES) {
      // reset per branch (beforeEach only runs once for the whole `it`)
      dbThrows = false;
      ambientTenant = RESOLVED_TENANT;
      recordsByTenant = new Map();
      const { hash, env, viewer } = branch.arrange();
      const res = await serveMediaByHash(
        hash,
        "original",
        new Request(`https://api.example.com/api/media/${hash}`),
        env,
        viewer,
      );
      // Pinned-deny assertion per branch gives a precise failure label.
      await expectPinnedDeny(res).catch((e) => {
        throw new Error(`deny branch "${branch.name}" was not the pinned deny: ${e}`);
      });
      snaps.push(await snapshot(res));
    }

    // All branches mutually byte-identical.
    const first = snaps[0];
    for (let i = 0; i < snaps.length; i++) {
      expect(snaps[i], `branch "${DENY_BRANCHES[i].name}" differs from branch "${DENY_BRANCHES[0].name}"`).toEqual(first);
    }
    // Sanity: we actually covered every enumerated branch.
    expect(snaps).toHaveLength(DENY_BRANCHES.length);
  });

  // --- Pin the exact deny contract (catches a UNIFORM body/header mutation) --

  it("the deny body equals the documented constant and the header set is exactly the three security headers", async () => {
    storeForViewer(record({ moderationStatus: "PENDING" }));
    const res = await serveMediaByHash(
      VALID_HASH,
      "original",
      req(),
      makeEnv(makeBucket()),
      VIEWERS[1],
    );
    expect(res.status).toBe(404);
    expect(await res.clone().text()).toBe('{"error":"Media not found"}');
    // No Content-Disposition, no Vary, no X-Trace-Id, no tenant hint — the deny
    // header set is frozen to exactly these three.
    expect([...res.headers.entries()].sort()).toEqual(DENY_HEADERS);
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  // --- CORS / origin independence ------------------------------------------

  it("deny is byte-identical across two different Origins (no origin-dependent oracle)", async () => {
    storeForViewer(record({ moderationStatus: "PENDING" }));
    const resA = await serveMediaByHash(
      VALID_HASH,
      "original",
      req("https://a.example.com"),
      makeEnv(makeBucket()),
      VIEWERS[1],
    );
    storeForViewer(record({ moderationStatus: "PENDING" }));
    const resB = await serveMediaByHash(
      VALID_HASH,
      "original",
      req("https://b.evil.test"),
      makeEnv(makeBucket()),
      VIEWERS[1],
    );
    // The CorsHandler is mocked to a pass-through here, so the deny carries NO
    // origin-dependent header at all; the point this asserts is that no
    // media-STATE-dependent header varies and the bytes are identical. Were the
    // real CORS shim attached, only the (uniformly-applied) origin header could
    // differ — never anything keyed on media state.
    expect(await snapshot(resA)).toEqual(await snapshot(resB));
  });

  // --- Tenant isolation (the cross-tenant leak guard) ----------------------

  it("scopes the DB lookup to the VIEWER's resolved tenant (composite unique carries that tenant)", async () => {
    storeForViewer(record({ moderationStatus: "APPROVED" }));
    await serveMediaByHash(
      VALID_HASH,
      "original",
      req(),
      makeEnv(makeBucket()),
      VIEWERS[1],
    );
    // The gate must have queried with the resolved viewer tenant — not a
    // hardcoded "global" / "" / undefined. A regression that hardcoded the
    // tenant would record a different value here.
    expect(findUniqueCalls).toContainEqual({
      tenantId: RESOLVED_TENANT,
      contentHash: VALID_HASH,
    });
    expect(findUniqueCalls.every((c) => c.tenantId === RESOLVED_TENANT)).toBe(true);
  });

  it("does NOT serve an APPROVED record owned by a DIFFERENT tenant (cross-tenant leak guard)", async () => {
    // A fully-servable APPROVED record exists under OTHER_TENANT only. The
    // viewer resolves to RESOLVED_TENANT. Correct code scopes by RESOLVED_TENANT,
    // misses, and denies. A regression that hardcoded `tenantId: "global"` (or
    // any other-tenant id) would read the foreign record and LEAK its bytes —
    // turning this test red.
    const bucket = makeBucket();
    recordsByTenant = new Map([
      [OTHER_TENANT, record({ moderationStatus: "APPROVED" })],
    ]);

    const res = await serveMediaByHash(
      VALID_HASH,
      "original",
      req(),
      makeEnv(bucket),
      VIEWERS[1],
    );

    await expectPinnedDeny(res);
    // The foreign tenant's bytes were never fetched.
    expect(bucket.get).not.toHaveBeenCalled();
    // And the query was scoped to the viewer's tenant, not the foreign one.
    expect(findUniqueCalls.every((c) => c.tenantId === RESOLVED_TENANT)).toBe(true);
    expect(findUniqueCalls.some((c) => c.tenantId === OTHER_TENANT)).toBe(false);
  });

  it("the SAME hash served to the viewer's tenant DOES serve (proves the miss above was tenant-scoping, not a blanket deny)", async () => {
    // Control for the leak test: with the APPROVED record under the viewer's
    // OWN tenant, the gate serves. This guarantees the cross-tenant denial is
    // caused by the tenant scoping and not by some unrelated always-deny.
    const bucket = makeBucket();
    storeForViewer(record({ moderationStatus: "APPROVED" }));

    const res = await serveMediaByHash(
      VALID_HASH,
      "original",
      req(),
      makeEnv(bucket),
      VIEWERS[1],
    );

    expect(res.status).toBe(200);
    expect(bucket.get).toHaveBeenCalledWith(APPROVED_KEY);
  });

  // --- Bypass / pre-lookup guards (retained) -------------------------------

  it("BYPASS: DB null but storage HAS the object → DENY", async () => {
    const bucket = makeBucket(); // get() would return secret bytes
    recordsByTenant = new Map(); // DB miss
    const res = await serveMediaByHash(
      VALID_HASH,
      "original",
      req(),
      makeEnv(bucket),
      VIEWERS[0],
    );
    await expectPinnedDeny(res);
    // Storage was never probed for an un-recorded object.
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("invalid hash never reaches the DB lookup", async () => {
    const res = await serveMediaByHash(
      "../../etc/passwd",
      "original",
      new Request("https://api.example.com/api/media/x"),
      makeEnv(makeBucket()),
      VIEWERS[0],
    );
    await expectPinnedDeny(res);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});
