/**
 * Validation Schemas
 *
 * Zod schemas for runtime input validation.
 * Used to validate request bodies and query parameters.
 */

import { z } from "zod";

/**
 * The source types a CLIENT may declare (AI Act Art. 50).
 *
 * `UNKNOWN` is omitted deliberately — it is the absence of a declaration, and
 * the way to express that is to omit the field. Accepting an explicit `UNKNOWN`
 * would give a client a way to *assert* "no signal" that is indistinguishable
 * from silence, and on the edit path it would read as an attempt to walk a
 * previous declaration back to nothing.
 *
 * `basis` is NOT declarable: see the note on `createPostSchema.provenance`.
 */
const declarableSourceType = z.enum([
  "HUMAN_CREATED",
  "AI_EDITED",
  "AI_ASSISTED",
  "AI_GENERATED",
]);

/**
 * Pagination query parameters
 */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  offset: z.coerce.number().int().min(0).max(10000).optional(),
});

/**
 * Create post request body
 */
export const createPostSchema = z.object({
  // .trim() runs BEFORE .min()/.max() so whitespace-only text (e.g. "   ")
  // fails length validation instead of passing min(1) and then trimming to
  // "" downstream (fail-closed: reject at the schema boundary, never accept
  // and silently persist empty content).
  text: z.string().trim().min(1).max(3000),
  visibility: z.enum(["public", "friends-only", "private"]).optional(),
  radius: z.enum(["SHOUT", "LOUD", "NORMAL", "WHISPER"]).optional(),
  entityRefs: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[a-z0-9]+$/, "Invalid entity ID format"), // CUID format validation
    )
    .max(20) // Maximum 20 entities per post
    .optional()
    .default([]),
  taxonomyTags: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[a-z-]+:[a-z-]+:[a-z-]+$/, "Invalid taxon ID format"), // Format: dimension:category:taxon
    )
    .max(20) // Maximum 20 taxonomy tags per post
    .optional()
    .default([]),
  geoData: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      place: z.string().optional(),
    })
    .optional(),
  contentWarnings: z.array(z.string()).max(10).optional(),
  // Synthetic-content provenance of the post TEXT (AI Act Art. 50).
  //
  // `.strict()` is load-bearing, not stylistic: a client may declare WHAT the
  // content is, never HOW WE KNOW it. `basis` is minted server-side, and
  // accepting it here would let any client forge `PLATFORM_GENERATED` — our own
  // strongest attestation. Strict mode REJECTS the extra key rather than
  // silently dropping it, so a client attempting it gets a 400 instead of a
  // false sense that its value was honoured.
  provenance: z
    .object({ sourceType: declarableSourceType })
    .strict()
    .optional(),
  media: z
    .array(
      // NOT `.strict()` here, deliberately. Unknown keys on a media item are
      // stripped as they always were — tightening it would 400 requests that
      // are valid today, and there is nothing security-sensitive to smuggle:
      // `basis` is not a field on this object.
      z.object({
        id: z.string(), // MediaFile ID
        alt: z.string().max(500).optional(), // Alt text for accessibility
        // Per-attachment provenance: one post can mix a human photo with an
        // AI-generated one, so this is per item, not per post.
        sourceType: declarableSourceType.optional(),
      }),
    )
    .max(4) // Maximum 4 images per post
    .optional(),
});

/**
 * Edit post request body
 *
 * Used for PATCH /api/posts/:postId endpoint.
 * Allows editing text, media, and visibility.
 */
export const editPostSchema = z.object({
  // .trim() runs BEFORE .min()/.max() so whitespace-only text (e.g. "   ")
  // fails length validation instead of passing min(1) and then trimming to
  // "" downstream (fail-closed: reject at the schema boundary, never accept
  // and silently persist empty content).
  text: z
    .string()
    .trim()
    .min(1, "Post text is required")
    .max(3000, "Post text exceeds maximum length"),
  visibility: z.enum(["public", "friends-only", "private"]).optional(),
  // Provenance of the post TEXT, MONOTONIC: the handler accepts this only when it
  // raises disclosure, never when it lowers it (AI Act Art. 50; see
  // analysis/ai-act-transparency 03 §6). Omitting it leaves the stored value
  // untouched — editing text never clears a declaration.
  provenance: z
    .object({ sourceType: declarableSourceType })
    .strict()
    .optional(),
  // NOTE: `media` here is accepted and then IGNORED — `editPost` only writes
  // text/editedAt/hasBlockedLinks/radius and never touches PostMedia. That is
  // pre-existing behaviour, out of scope to fix here.
  //
  // Provenance is deliberately NOT offered on these items: an API that appears
  // to accept a disclosure and silently drops it is worse than one that does not
  // offer it. Per-attachment declaration happens at post creation.
  media: z
    .array(
      z.object({
        id: z.string().optional(), // Existing media ID
        alt: z.string().max(500).optional(), // Alt text for accessibility
      }),
    )
    .max(10) // Maximum 10 media attachments
    .optional(),
});

/**
 * Create comment request body
 */
export const createCommentSchema = z.object({
  // .trim() runs BEFORE .min()/.max() so whitespace-only text fails length
  // validation instead of passing min(1) and then trimming to "" downstream
  // (fail-closed: reject at the schema boundary, never persist empty content).
  text: z.string().trim().min(1).max(3000),
});

/**
 * Update sentiment request body
 */
export const sentimentSchema = z.object({
  sentiment: z.enum([
    "joy",
    "gratitude",
    "calm",
    "love",
    "hope",
    "compassion",
    "awe",
    "sadness",
    "anger",
    "fear",
    "insightful",
  ]),
});

/**
 * Badge visibility request body
 */
export const badgeSchema = z.object({
  showVerifiedBadge: z.boolean(),
});

/**
 * Privacy preferences request body
 */
export const privacyPreferencesSchema = z.object({
  profileVisibility: z.enum(["public", "followers", "private"]).optional(),
  showEmail: z.boolean().optional(),
  showLocation: z.boolean().optional(),
  allowFriendRequests: z.boolean().optional(),
});

/**
 * Invitation creation request body
 */
export const createInvitationSchema = z.object({
  email: z.string().email().toLowerCase().optional(),
  expiresInDays: z.coerce.number().int().min(1).max(365).default(30),
  recaptchaToken: z.string().optional(),
});

/**
 * Validate invitation request body
 */
export const validateInvitationSchema = z.object({
  code: z.string().min(1).max(100).trim().toUpperCase(),
  email: z.string().email().toLowerCase().optional(),
});

/**
 * Delete account confirmation request body
 */
export const deleteAccountConfirmationSchema = z.object({
  confirmationCode: z.string().min(1).max(100).trim(),
});

/**
 * Feature toggle request body
 */
export const featureToggleSchema = z.object({
  enabled: z.boolean(),
});

/**
 * User signup mode request body
 */
export const signupModeSchema = z.object({
  mode: z.enum(["open", "invitation_only"]),
});

/**
 * Connection code request body
 */
export const connectionCodeSchema = z.object({
  code: z.string().min(1).max(100).trim(),
});

/**
 * Friend request body
 */
export const friendRequestSchema = z.object({
  inviterId: z.string().min(1).max(200).optional(),
});

/**
 * Email request body (for password reset, etc.)
 */
export const emailRequestSchema = z.object({
  email: z.string().email().toLowerCase(),
});

/**
 * Feed query parameters (extends pagination)
 */
export const feedQuerySchema = paginationSchema.extend({
  entityRefs: z.array(z.string()).max(20).optional(), // Filter by multiple entities
  taxonomyTags: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[a-z-]+:[a-z-]+:[a-z-]+$/, "Invalid taxon ID format"),
    )
    .max(20)
    .optional(), // Filter by taxonomy tags (taxonIds)
  personalized: z.coerce.boolean().optional(), // Enable personalization based on user's entity tags
  personalizationEntityIds: z.array(z.string()).max(20).optional(), // Specific entity IDs for personalization
});

/**
 * Get sentiment users query parameters
 * For "who reacted" feature - returns users who reacted with specific sentiments
 */
export const getSentimentUsersSchema = z.object({
  postId: z.string().uuid("Post ID must be a valid UUID"),
  sentiment: z
    .enum([
      "joy",
      "gratitude",
      "calm",
      "love",
      "hope",
      "compassion",
      "awe",
      "sadness",
      "anger",
      "fear",
      "insightful",
    ])
    .optional(),
  limit: z.coerce
    .number()
    .int("Limit must be an integer")
    .min(1, "Limit must be at least 1")
    .max(100, "Limit must not exceed 100")
    .default(20),
  cursor: z
    .string()
    .refine(
      (c) => {
        try {
          const decoded = JSON.parse(Buffer.from(c, "base64").toString());
          return (
            typeof decoded === "object" &&
            decoded !== null &&
            typeof decoded.lastId === "string" &&
            decoded.lastId.length > 0 &&
            decoded.lastId.length <= 200 &&
            typeof decoded.lastCreatedAt === "string" &&
            decoded.lastCreatedAt.length > 0 &&
            decoded.lastCreatedAt.length <= 50 &&
            Object.keys(decoded).length === 2
          );
        } catch {
          return false;
        }
      },
      { message: "Invalid cursor format" },
    )
    .optional(),
});

// ============================================================================
// Events primitive (R1 — plans/events-primitive/README.md §4.2, §4.5, §4.8)
//
// .trim() runs BEFORE .min()/.max() so whitespace-only strings fail length
// validation instead of passing min(1) and then trimming to "" downstream
// (fail-closed at the boundary — same convention as createPostSchema).
//
// Client-supplied enums exclude WAITLISTED: waitlist placement is decided by
// the server's atomic capacity check (§4.3), never chosen by the caller.
// displayLat/displayLng are DERIVED by the handler (location fuzzing), never
// accepted from the client — the schema only takes the true lat/lng +
// precision. Operational caps that are threshold-secret (guests-per-RSVP, the
// list page size) arrive as parameters from env.event.* (CLAUDE.md rule 8),
// so those two schemas are factory functions rather than module constants.
// ============================================================================

const eventVisibilitySchema = z.enum(["TENANT_ONLY", "GROUP_ONLY", "PUBLIC"]);
const eventLocationPrecisionSchema = z.enum([
  "EXACT",
  "NEIGHBORHOOD",
  "CITY",
  "HIDDEN",
]);
const eventStatusSchema = z.enum(["DRAFT", "PUBLISHED", "CANCELLED"]);
// IANA timezone identifier (e.g. "Europe/Berlin"). Kept a bounded free string
// at the boundary; the handler validates it against Intl before persisting.
const eventTimezoneSchema = z.string().trim().min(1).max(64);
const eventLatSchema = z.number().min(-90).max(90);
const eventLngSchema = z.number().min(-180).max(180);

/**
 * Create event request body. `startsAt`/`endsAt` are ISO 8601 datetimes
 * (offsets allowed); a present `endsAt` must not precede `startsAt`.
 */
export const createEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).optional(),
    visibility: eventVisibilitySchema.optional(),
    groupId: z.string().trim().min(1).max(100).optional(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).optional(),
    timezone: eventTimezoneSchema.optional(),
    locationName: z.string().trim().min(1).max(300).optional(),
    lat: eventLatSchema.optional(),
    lng: eventLngSchema.optional(),
    locationPrecision: eventLocationPrecisionSchema.optional(),
    // null = unlimited; omit or send null for no cap.
    capacity: z.number().int().min(1).max(1_000_000).nullish(),
  })
  .refine((v) => v.endsAt === undefined || v.endsAt >= v.startsAt, {
    message: "endsAt must not precede startsAt",
    path: ["endsAt"],
  });

/**
 * Edit event request body. All fields optional (partial update). `status`
 * carries the DRAFT→PUBLISHED publish transition (cancellation is the DELETE
 * route). endsAt/startsAt cross-field check applies only when both are present.
 */
export const editEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).optional(),
    visibility: eventVisibilitySchema.optional(),
    status: eventStatusSchema.optional(),
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).nullish(),
    timezone: eventTimezoneSchema.optional(),
    locationName: z.string().trim().min(1).max(300).nullish(),
    lat: eventLatSchema.nullish(),
    lng: eventLngSchema.nullish(),
    locationPrecision: eventLocationPrecisionSchema.optional(),
    capacity: z.number().int().min(1).max(1_000_000).nullish(),
  })
  .refine(
    (v) =>
      v.startsAt === undefined ||
      v.endsAt === undefined ||
      v.endsAt === null ||
      v.endsAt >= v.startsAt,
    { message: "endsAt must not precede startsAt", path: ["endsAt"] },
  );

/**
 * RSVP request body. `guests` is clamped at the boundary to the env-supplied
 * `maxGuests` (env.event.maxGuestsPerRsvp) — a threshold-secret cap, hence a
 * factory rather than a hardcoded max (§4.3 SEC-1, §4.8). Party size = 1 +
 * guests. WAITLISTED is never a client-selectable status.
 */
export const rsvpSchema = (maxGuests: number) =>
  z.object({
    status: z.enum(["GOING", "MAYBE", "NOT_GOING"]),
    guests: z.number().int().min(0).max(maxGuests).default(0),
  });

/**
 * Shift (Dienstplan slot) create/edit body. For edits, callers apply
 * `.partial()`. `capacity` is a positive int; its upper bound is a plain
 * sanity guard (not a security threshold). endsAt must not precede startsAt.
 */
export const shiftSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
    capacity: z.number().int().min(1).max(1_000_000),
  })
  .refine(
    (v) => v.startsAt === undefined || v.endsAt === undefined || v.endsAt >= v.startsAt,
    { message: "endsAt must not precede startsAt", path: ["endsAt"] },
  );

/**
 * Shift signup body. Signup carries no user-chosen fields — CONFIRMED vs
 * WAITLISTED is decided by the server's atomic capacity check. Present as a
 * boundary marker; extra properties are ignored.
 */
export const shiftSignupSchema = z.object({});

/**
 * Event list query parameters. `limit` is bounded by the env-supplied
 * `listPageMax` (env.event.listPageMax) — threshold-secret, hence a factory.
 * Keyset cursor is an opaque string decoded by the handler (§4.5).
 */
export const eventListQuerySchema = (listPageMax: number) =>
  z.object({
    limit: z.coerce.number().int().min(1).max(listPageMax).default(20),
    cursor: z.string().optional(),
    upcoming: z.coerce.boolean().optional(),
    groupId: z.string().trim().min(1).max(100).optional(),
    status: eventStatusSchema.optional(),
  });
