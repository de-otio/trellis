/**
 * Shared read-side visibility helpers for the Events primitive (§4.4).
 *
 * Both `RsvpHandler` and `ShiftHandler` gate access to an event by the same
 * rule: a caller must be in the event's tenant, and for a `GROUP_ONLY` event
 * must additionally be a `GroupMember` of `event.groupId`. Factored here so the
 * check cannot drift between the two participant-facing handlers (review F-3 —
 * ShiftHandler previously enforced tenant + existence but NOT visibility, so a
 * same-tenant non-group-member could sign up for / list a GROUP_ONLY event's
 * shifts).
 *
 * Design: plans/events-primitive/README.md §4.4.
 */

import type { AuthContext } from "../auth/auth-context.js";
import { Capability, RoleGrants } from "../auth/require.js";

/** Minimal Prisma surface the group-membership check needs. */
interface GroupMemberDb {
  user: { findUnique: (...args: any[]) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  groupMember: { findFirst: (...args: any[]) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * Is `userId` a member of `groupId` within `tenantId`? Resolved via the user's
 * `actorUri` (group membership is keyed by actor, not user id). Returns false
 * for a null group or an actor-less user — never throws for those.
 */
export async function isGroupMember(
  db: GroupMemberDb,
  groupId: string | null,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  if (!groupId) return false;
  const user = (await db.user.findUnique({
    where: { id: userId },
    select: { actorUri: true },
  })) as { actorUri: string | null } | null;
  if (!user?.actorUri) return false;
  const membership = await db.groupMember.findFirst({
    where: { groupId, actorUri: user.actorUri, tenantId },
    select: { id: true },
  });
  return membership !== null;
}

/**
 * Does `auth` hold the cross-user `EventModerate` capability (ADMIN+ /
 * SUPER_ADMIN)? Mirrors `EventHandler.isModerator`.
 */
export function isEventModerator(auth: AuthContext): boolean {
  if (auth.globalRole === "SUPER_ADMIN") return true;
  return RoleGrants[auth.tenantRole]?.has(Capability.EventModerate) === true;
}
