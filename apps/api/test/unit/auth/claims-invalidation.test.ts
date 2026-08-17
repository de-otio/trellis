/**
 * Unit Tests: claims-cache invalidation choke point.
 *
 * ## Why this matters
 *
 * The Cognito pre-token-generation Lambda re-derives every authorization claim
 * from Postgres — but only on a cache MISS. `lambda/pre-token-generation.ts`
 * says so explicitly:
 *
 *   > Cache hits skip the user-suspension and tenant-status checks below
 *   > (RDS is only consulted on miss). The mitigation is *active invalidation*.
 *   > … Tracked as G2 finding H3.
 *
 * So the claims cache (keyed by Cognito `sub`, ~1h TTL) — not the Lambda's
 * derivation logic — is the live authorization boundary. Any admin path that
 * changes a user's authorization state without invalidating leaves the OLD
 * privileges mintable into brand-new JWTs for up to the TTL.
 *
 * These tests pin (a) the choke point's own behaviour and (b) that every
 * privilege-changing write in `src/` routes through it — including the
 * structural guard that fails when a NEW mutation site forgets.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  invalidateClaims,
  invalidateClaimsForUserId,
  __setClaimsCacheForInvalidationTest,
} from "../../../src/lib/auth/claims-invalidation.js";

const invalidateSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  invalidateSpy.mockResolvedValue(undefined);
  __setClaimsCacheForInvalidationTest({
    invalidate: invalidateSpy,
  } as never);
});

describe("invalidateClaims", () => {
  it("invalidates the given subject", async () => {
    await invalidateClaims(["sub-1"], "member.remove");
    expect(invalidateSpy).toHaveBeenCalledExactlyOnceWith("sub-1");
  });

  it("invalidates BOTH subjects on an ownership transfer", async () => {
    await invalidateClaims(["old-owner", "new-owner"], "tenant.transfer");
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenCalledWith("old-owner");
    expect(invalidateSpy).toHaveBeenCalledWith("new-owner");
  });

  it("collapses duplicates so one sub is invalidated once", async () => {
    await invalidateClaims(["s", "s", "s"], "x");
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("skips null / undefined / empty subjects (a user with no IdP identity)", async () => {
    await invalidateClaims([null, undefined, ""], "x");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("is best-effort: a cache failure does not throw at the call site", async () => {
    invalidateSpy.mockRejectedValue(new Error("KV down"));
    // The DB write has already committed; a cache outage must not surface as a
    // failed suspension. The cache converges within one TTL regardless.
    await expect(invalidateClaims(["s"], "x")).resolves.toBeUndefined();
  });

  it("one failing subject does not prevent the other being invalidated", async () => {
    invalidateSpy.mockRejectedValueOnce(new Error("KV down"));
    await invalidateClaims(["a", "b"], "x");
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });
});

describe("invalidateClaimsForUserId", () => {
  it("looks the subject up by user id and invalidates it", async () => {
    const db = {
      user: { findUnique: vi.fn().mockResolvedValue({ subject: "sub-9" }) },
    };
    await invalidateClaimsForUserId(db, "user-9", "user.deletion_request");

    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-9" },
      select: { subject: true },
    });
    expect(invalidateSpy).toHaveBeenCalledExactlyOnceWith("sub-9");
  });

  it("no-ops when the user has no subject", async () => {
    const db = {
      user: { findUnique: vi.fn().mockResolvedValue({ subject: null }) },
    };
    await invalidateClaimsForUserId(db, "user-9", "x");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("does not throw when the subject lookup fails", async () => {
    const db = {
      user: { findUnique: vi.fn().mockRejectedValue(new Error("db down")) },
    };
    await expect(
      invalidateClaimsForUserId(db, "user-9", "x"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Structural guard.
//
// The per-path tests below only cover the paths we know about. This one covers
// the paths we DON'T: it scans `src/` for Prisma writes that change
// authorization state (`suspended` / `role` inside a `data: { … }` block) and
// fails when the containing file does not reference the invalidation choke
// point. That is the test the coordinator asked for — it fails when someone
// adds a fifth mutation path and forgets, without needing a per-caller test.
// ---------------------------------------------------------------------------

const SRC_ROOT = new URL("../../../src", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Extract the body of every `data: { … }` object literal in `src`. */
function dataBlocks(src: string): string[] {
  const blocks: string[] = [];
  const re = /data:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = re.lastIndex;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    blocks.push(src.slice(re.lastIndex, i));
  }
  return blocks;
}

/**
 * Files allowed to write authorization state WITHOUT referencing the choke
 * point, each with the reason. Keep this list short and justified — adding an
 * entry is a deliberate decision, which is the point.
 */
const ALLOWED_WITHOUT_INVALIDATION: Record<string, string> = {
  "lambda/pre-token-generation.ts":
    "It IS the token issuer: it persists a federated role refresh and writes the " +
    "fresh claims into the cache in the same invocation, so there is nothing stale to purge.",
  "lib/identity/provision-confirmed-user.ts":
    "First-contact provisioning — the identity does not exist yet, so no cache entry can exist.",
  "lib/tenant/transfer-ownership.ts":
    "Pure transaction helper; it returns both Cognito subs and its two callers " +
    "(tenant-handler, member-handler) do the invalidating.",
  "lib/activitypub/group-service.ts":
    "ActivityPub GroupMember.role — a federation membership row, not a trellis " +
    "authorization claim; nothing in the JWT derives from it.",
  "lib/activitypub/activity-processor.ts":
    "Same: ActivityPub GroupMember.role, not a trellis authorization claim.",
};

describe("structural guard: privilege writes route through the choke point", () => {
  const offenders: Array<{ file: string; snippet: string }> = [];

  for (const abs of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, abs);
    if (rel.startsWith("lib/auth/claims-invalidation")) continue;
    const src = readFileSync(abs, "utf8");

    const writesPrivilegeState = dataBlocks(src).some(
      (b) => /\b(suspended|suspendedAt)\s*:/.test(b) || /\brole\s*:/.test(b),
    );
    if (!writesPrivilegeState) continue;
    if (rel in ALLOWED_WITHOUT_INVALIDATION) continue;

    if (!src.includes("claims-invalidation")) {
      offenders.push({ file: rel, snippet: "" });
    }
  }

  it("every file writing `suspended`/`role` imports claims-invalidation (or is explicitly exempt)", () => {
    expect(
      offenders.map((o) => o.file),
      "These files mutate authorization state but never invalidate the claims " +
        "cache. A pre-token-generation cache HIT skips the RDS suspension/role " +
        "read, so the OLD privileges stay mintable for up to the cache TTL. " +
        "Either call invalidateClaims/invalidateClaimsForUserId after the write, " +
        "or add the file to ALLOWED_WITHOUT_INVALIDATION with a justification.",
    ).toEqual([]);
  });

  it("the exemption list only names files that still exist and still write privilege state", () => {
    // Keeps the allow-list from silently rotting into a blanket exemption.
    for (const rel of Object.keys(ALLOWED_WITHOUT_INVALIDATION)) {
      const src = readFileSync(join(SRC_ROOT, rel), "utf8");
      expect(
        dataBlocks(src).some(
          (b) => /\b(suspended|suspendedAt)\s*:/.test(b) || /\brole\s*:/.test(b),
        ),
        `${rel} no longer writes privilege state — drop its exemption`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-path coverage: the four mutation classes the audit enumerated.
// ---------------------------------------------------------------------------

describe("audit: each privilege-changing path invalidates", () => {
  function srcOf(rel: string): string {
    return readFileSync(join(SRC_ROOT, rel), "utf8");
  }

  it("user suspension (user-deprovisioning.suspendUser)", () => {
    expect(srcOf("lib/user-deprovisioning.ts")).toContain(
      'invalidateClaims([userRow?.subject], "user.suspend")',
    );
  });

  it("user restore (user-deprovisioning.restoreUser)", () => {
    expect(srcOf("lib/user-deprovisioning.ts")).toContain(
      'invalidateClaims([userRow?.subject], "user.restore")',
    );
  });

  it("deletion request — a suspension path that was MISSING invalidation", () => {
    expect(srcOf("lib/user-deletion-handler-enhanced.ts")).toContain(
      '"user.deletion_request"',
    );
  });

  it("global-role change via the admin dashboard — was MISSING invalidation", () => {
    expect(srcOf("lib/routes/dashboard.ts")).toContain(
      '"user.change_global_role"',
    );
  });

  it("tenant-member role change", () => {
    expect(srcOf("lib/tenant/member-handler.ts")).toContain(
      '"member.change_role"',
    );
  });

  it("tenant-member removal", () => {
    expect(srcOf("lib/tenant/member-handler.ts")).toContain('"member.remove"');
  });

  it("OWNER transfer invalidates BOTH subjects", () => {
    const src = srcOf("lib/tenant/member-handler.ts");
    expect(src).toContain("result.oldOwnerCognitoSub");
    expect(src).toContain("result.newOwnerCognitoSub");
    expect(src).toContain('"tenant.transfer_ownership"');
  });

  it("tenant creation (new OWNER membership + global-role bump) — was MISSING", () => {
    expect(srcOf("lib/tenant/tenant-handler.ts")).toContain('"tenant.create"');
  });
});
