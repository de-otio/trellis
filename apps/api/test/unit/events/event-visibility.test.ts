/**
 * Unit tests: shared read-side visibility helpers (event-visibility.ts).
 *
 * `isGroupMember` and `isEventModerator` are the factored-out checks both
 * `RsvpHandler` and `ShiftHandler` gate on (review F-3). They take their Prisma
 * surface / `AuthContext` by argument, so they test with plain fakes — no module
 * mocking needed. Covers both true/false branches of each: group-member vs not,
 * null group, actor-less user, and creator/EventModerate/neither for moderator.
 */

import { describe, expect, it, vi } from "vitest";
import type { TenantRole, UserRole } from "@prisma/client";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import {
  isEventModerator,
  isGroupMember,
} from "../../../src/lib/events/event-visibility.js";

const TENANT_A = "tenant-a-id";
const USER_ID = "caller-user-id";
const ACTOR_URI = "https://example.com/ap/users/caller";

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    cognitoSub: "cognito-sub-caller",
    userId: USER_ID,
    globalRole: "END_USER" as UserRole,
    activeTenantId: TENANT_A,
    tenantSlug: "org-a",
    tenantRole: "MEMBER" as TenantRole,
    handle: "caller",
    membershipsLoader: async () => [],
    ...overrides,
  };
}

/** A fake GroupMemberDb whose two delegates are individually programmable. */
function makeDb(opts: {
  user?: { actorUri: string | null } | null;
  membership?: { id: string } | null;
}) {
  const findUnique = vi.fn().mockResolvedValue(
    opts.user === undefined ? { actorUri: ACTOR_URI } : opts.user,
  );
  const findFirst = vi
    .fn()
    .mockResolvedValue(opts.membership === undefined ? { id: "gm-1" } : opts.membership);
  return {
    db: {
      user: { findUnique },
      groupMember: { findFirst },
    },
    findUnique,
    findFirst,
  };
}

describe("isGroupMember", () => {
  it("returns false immediately for a null groupId (never queries)", async () => {
    const { db, findUnique, findFirst } = makeDb({});
    const result = await isGroupMember(db, null, USER_ID, TENANT_A);
    expect(result).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns false when the user row does not exist", async () => {
    const { db, findFirst } = makeDb({ user: null });
    const result = await isGroupMember(db, "group-1", USER_ID, TENANT_A);
    expect(result).toBe(false);
    // No actorUri → the membership lookup is never reached.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns false for an actor-less user (never queries membership)", async () => {
    const { db, findFirst } = makeDb({ user: { actorUri: null } });
    const result = await isGroupMember(db, "group-1", USER_ID, TENANT_A);
    expect(result).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns true when a membership row exists, keyed by the resolved actorUri", async () => {
    const { db, findUnique, findFirst } = makeDb({ membership: { id: "gm-1" } });
    const result = await isGroupMember(db, "group-1", USER_ID, TENANT_A);
    expect(result).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { actorUri: true },
    });
    // Membership is resolved by actorUri (not user id) and scoped to the tenant.
    expect(findFirst).toHaveBeenCalledWith({
      where: { groupId: "group-1", actorUri: ACTOR_URI, tenantId: TENANT_A },
      select: { id: true },
    });
  });

  it("returns false when no membership row exists for the (group, actor, tenant)", async () => {
    const { db } = makeDb({ membership: null });
    const result = await isGroupMember(db, "group-1", USER_ID, TENANT_A);
    expect(result).toBe(false);
  });
});

describe("isEventModerator", () => {
  it("returns true for a SUPER_ADMIN global role regardless of tenant role", async () => {
    expect(
      isEventModerator(makeAuth({ globalRole: "SUPER_ADMIN" as UserRole, tenantRole: "GUEST" as TenantRole })),
    ).toBe(true);
  });

  it("returns true for an ADMIN tenant role (holds EventModerate)", async () => {
    expect(isEventModerator(makeAuth({ tenantRole: "ADMIN" as TenantRole }))).toBe(true);
  });

  it("returns true for an OWNER tenant role (holds EventModerate)", async () => {
    expect(isEventModerator(makeAuth({ tenantRole: "OWNER" as TenantRole }))).toBe(true);
  });

  it("returns false for a MEMBER tenant role (no EventModerate)", async () => {
    expect(isEventModerator(makeAuth({ tenantRole: "MEMBER" as TenantRole }))).toBe(false);
  });

  it("returns false for a GUEST tenant role (no EventModerate)", async () => {
    expect(isEventModerator(makeAuth({ tenantRole: "GUEST" as TenantRole }))).toBe(false);
  });
});
