/**
 * PostFeedAnnouncer — concrete `FeedAnnouncer` (Events primitive, R1, Phase 2).
 *
 * The DI assembly that wires the event handlers' companion-Post lifecycle to
 * the `PostHandler` system-post seam (`createSystemPost` / `updateSystemPost` /
 * `retractSystemPost`). This is pure DI/composition — it adds no domain logic
 * of its own: the visibility→radius decision and the location precision filter
 * are the SHARED PURE helpers from `seams.ts` (`planCompanionPost`,
 * `precisionFilteredLocation`), so the SEC-2 (visibility leak) and SEC-6
 * (location privacy) guarantees are made once, in one place, and reused here.
 *
 *  - announce  → GROUP_ONLY yields NO companion Post (no safe feed radius,
 *    §4.6 SEC-2) → returns null; otherwise composes a precision-filtered body,
 *    resolves the radius from visibility, and creates the Post through the seam,
 *    returning its id to store on `Event.announcePostId`.
 *  - update    → recompose the precision-filtered body and update the companion
 *    Post (local feed consistency + cache bump). No-op when there is no
 *    companion Post id.
 *  - retract   → soft-delete the companion Post so it stops surfacing in feeds.
 *    No-op when there is no companion Post id.
 *
 * `update`/`retract` are best-effort (they swallow + log their own errors) so a
 * feed hiccup never turns an already-persisted event edit/cancel into a 500.
 *
 * Region/base-URL come from `env` (there is no request at this seam): the
 * companion Post is authored in the default data region and AP URIs are built
 * from the federation base URL — matching how `createSystemPost` consumes them.
 *
 * Design: plans/events-primitive/README.md §4.6 (HIGH-1, SEC-2, SEC-6).
 */

import type { Env } from "../../env.js";
import { getLogger } from "../logger.js";
import {
  planCompanionPost,
  precisionFilteredLocation,
  type EventAnnouncementInput,
  type FeedAnnouncer,
  type FilteredLocation,
} from "./seams.js";

/**
 * Compose the companion Post body from a precision-filtered view of the event.
 * Deliberately plain text (no raw coordinates) — the location line is only ever
 * the filtered label, so nothing below EXACT precision leaks (§4.6 SEC-6).
 */
function composeBody(
  input: EventAnnouncementInput,
  location: FilteredLocation,
): string {
  const lines = [input.title];
  lines.push(`When: ${input.startsAt} (${input.timezone})`);
  if (location.label) lines.push(`Where: ${location.label}`);
  if (input.description) lines.push("", input.description);
  return lines.join("\n");
}

export class PostFeedAnnouncer implements FeedAnnouncer {
  async announce(input: EventAnnouncementInput, env: Env): Promise<string | null> {
    const plan = planCompanionPost(input.visibility);
    if (plan.kind === "none") return null;

    const location = precisionFilteredLocation(input.location);
    const geoData =
      location.lat != null && location.lng != null
        ? { lat: location.lat, lng: location.lng, place: location.label ?? undefined }
        : undefined;

    const { PostHandler } = await import("../post-handler.js");
    const handler = new PostHandler();
    const { postId } = await handler.createSystemPost(
      {
        authorId: input.creatorId,
        tenantId: input.tenantId,
        text: composeBody(input, location),
        radius: plan.radius,
        region: env.DEFAULT_REGION ?? "EU",
        baseUrl: env.ACTIVITYPUB_BASE_URL ?? "",
        geoData,
      },
      env,
    );
    return postId;
  }

  async update(input: EventAnnouncementInput, env: Env): Promise<void> {
    if (!input.announcePostId) return;
    try {
      const location = precisionFilteredLocation(input.location);
      const { PostHandler } = await import("../post-handler.js");
      await new PostHandler().updateSystemPost(
        input.announcePostId,
        composeBody(input, location),
        env,
      );
    } catch (error) {
      getLogger().error(
        "[PostFeedAnnouncer] companion-post update failed (best-effort)",
        { eventId: input.eventId, postId: input.announcePostId, error },
      );
    }
  }

  async retract(input: EventAnnouncementInput, env: Env): Promise<void> {
    if (!input.announcePostId) return;
    try {
      const { PostHandler } = await import("../post-handler.js");
      await new PostHandler().retractSystemPost(input.announcePostId, env);
    } catch (error) {
      getLogger().error(
        "[PostFeedAnnouncer] companion-post retract failed (best-effort)",
        { eventId: input.eventId, postId: input.announcePostId, error },
      );
    }
  }
}
