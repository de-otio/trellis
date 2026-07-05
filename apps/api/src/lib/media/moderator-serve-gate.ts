/**
 * Moderator serve-gate (T9) — the audited-bypass counterpart to serve-gate.ts.
 *
 * The public serve gate (`isServable`, serve-gate.ts) allows ONLY `APPROVED`,
 * for every viewer including the owner — there is no bypass. A human moderator,
 * however, must be able to VIEW the bytes of an item that is awaiting their
 * decision (lifecycle `REVIEW` or `QUARANTINED`) in order to decide it. This
 * module is the pure, total predicate for that narrow bypass.
 *
 * TWO hard invariants, both property-testable here with no I/O:
 *  1. The bypass NEVER widens the public gate: `moderatorCanServe` returns true
 *     for the review states ONLY. `APPROVED` is served through the normal gate;
 *     `REJECTED` / `UPLOAD_FAILED` / `AWAITING_UPLOAD` / `UPLOADED` are NEVER
 *     served through the bypass (a rejected/CSAM item is never re-shown, and an
 *     un-moderated/unconfirmed object has no moderator-review purpose).
 *  2. The bypass is MODERATOR-only and AUDITED: the imperative shell
 *     (media-review-handler.ts) must (a) confirm the caller's server-resolved
 *     role is MODERATOR/SUPER_ADMIN and (b) write an AuditEvent BEFORE streaming
 *     bytes. This module only decides *which lifecycle states* are bypass-
 *     eligible; the role check and the audit write live in the shell.
 *
 * Pure functional core: no I/O, no clock, no Prisma import. Lives in the PUBLIC
 * npm tarball — NO thresholds, secrets, or category vocabulary.
 */

import type { MediaLifecycle } from "./media-lifecycle.js";

/**
 * The lifecycle states a moderator is reviewing — the ONLY states the audited
 * moderator bypass will serve. A frozen tuple so tests can iterate it
 * exhaustively.
 */
export const MODERATOR_REVIEWABLE_LIFECYCLES = [
  "REVIEW",
  "QUARANTINED",
] as const satisfies readonly MediaLifecycle[];

/**
 * Whether the audited moderator bypass may serve an object in the given
 * lifecycle state. True IFF the state is one a moderator is actively reviewing
 * (`REVIEW` / `QUARANTINED`). Every other state — including `APPROVED` (served
 * through the normal public gate, never the bypass) and every terminal/pre-
 * moderation state — is false.
 *
 * Deliberately narrow and fail-closed: an unknown/never value returns false.
 */
export function moderatorCanServe(status: MediaLifecycle): boolean {
  return status === "REVIEW" || status === "QUARANTINED";
}

/**
 * The full moderator-bypass serve decision for a looked-up media record. Mirrors
 * `isServable` but for the review states, and — crucially — STILL honours the
 * `deletedAt` kill switch: a soft-deleted object is never served, not even to a
 * moderator (deletion is a terminal operator action). `hidden` is intentionally
 * NOT a block here: a moderator hiding-then-reviewing an item must still see it;
 * the CSAM-lock path sets `hidden` yet the item is REJECTED (not reviewable), so
 * it is denied by the lifecycle check regardless.
 */
export function isModeratorServable(record: {
  lifecycle: MediaLifecycle;
  deletedAt: Date | null;
}): boolean {
  if (record.deletedAt !== null && record.deletedAt !== undefined) {
    return false;
  }
  return moderatorCanServe(record.lifecycle);
}
