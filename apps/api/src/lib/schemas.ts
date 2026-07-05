/**
 * Validation Schemas
 *
 * Zod schemas for runtime input validation.
 * Used to validate request bodies and query parameters.
 */

import { z } from "zod";

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
  media: z
    .array(
      z.object({
        id: z.string(), // MediaFile ID
        alt: z.string().max(500).optional(), // Alt text for accessibility
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
