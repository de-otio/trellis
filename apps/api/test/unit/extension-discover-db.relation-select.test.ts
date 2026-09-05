/**
 * Unit Tests: discover() relation projection (quality sweep 2026-09-05, C2).
 *
 * `guardProjection` rejects `include` (any) and a *nested object* `select`.
 * `guardColumns` rejects an excluded SCALAR column. Neither rejects a relation
 * named with a boolean:
 *
 *     discover("post").findMany({ select: { id: true, author: true } })
 *
 * `author` is not a scalar, so the excluded-column set does not contain it, and
 * `true` is not a plain object, so the nested-select branch does not fire. The
 * read is served and Prisma returns the whole related row.
 *
 * That is the column allow-list defeated on the one surface that is
 * deliberately cross-tenant: every SHOUT post comes back with its author's
 * `User` row and, via `tenant`, the tenant row — the author→tenant map the
 * exclusion of `tenantId` from every model exists to prevent.
 *
 * `orderBy` on a relation is unguarded on the same reasoning and is covered
 * here too: it does not return the relation, but it lets a caller sort the
 * cross-tenant result set by a column it may not read, which is an oracle over
 * exactly that column.
 *
 * MODEL_META already holds a DMMF-derived relation set per model, so the fix is
 * to consult it in both guards.
 */

import { describe, it, expect } from "vitest";
import {
  planDiscoverOp,
  DiscoverGuardError,
} from "../../src/lib/extension-discover-db.js";

const ALLOWED = new Set([
  "post",
  "postTaxonomyTag",
  "taxonomyTaxon",
  "taxonomyCategory",
  "taxonomyDimension",
]);

const plan = (args: unknown) =>
  planDiscoverOp("post", "findMany", args, ALLOWED, "EU");

describe("discover() — a relation cannot be projected", () => {
  it("rejects a boolean-valued relation in select", () => {
    expect(() => plan({ select: { id: true, author: true } })).toThrow(
      DiscoverGuardError,
    );
  });

  it("rejects the tenant relation in select (the author→tenant map)", () => {
    expect(() => plan({ select: { id: true, tenant: true } })).toThrow(
      DiscoverGuardError,
    );
  });

  it("still rejects a nested object select (existing guard, unchanged)", () => {
    expect(() => plan({ select: { author: { select: { email: true } } } })).toThrow(
      DiscoverGuardError,
    );
  });

  it("still permits a scalar-only select", () => {
    expect(() => plan({ select: { id: true, createdAt: true } })).not.toThrow();
  });
});

describe("discover() — a relation cannot be ordered on", () => {
  it("rejects orderBy traversing a relation", () => {
    expect(() => plan({ orderBy: { author: { handle: "asc" } } })).toThrow(
      DiscoverGuardError,
    );
  });

  it("still permits orderBy on a permitted scalar", () => {
    expect(() => plan({ orderBy: { createdAt: "desc" } })).not.toThrow();
  });
});
