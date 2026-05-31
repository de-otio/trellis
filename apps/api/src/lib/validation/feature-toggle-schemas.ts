/**
 * Feature Toggle Validation Schemas
 *
 * Comprehensive input validation schemas for feature toggle API endpoints.
 * Uses Zod for runtime validation and type safety.
 *
 * SECURITY: These schemas prevent:
 * - SQL injection attacks
 * - XSS attacks
 * - Invalid data types
 * - Out-of-range values
 * - Malformed input
 */

import { z } from "zod";

/**
 * SQL injection pattern detection helper
 *
 * SECURITY: Detects common SQL injection patterns in user input
 */
function containsSQLInjection(input: string): boolean {
  const sqlPatterns = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE)\b)/i,
    /(--|#|\/\*|\*\/)/,
    /(;|\||&)/,
    /(UNION.*SELECT)/i,
    /(OR\s+1\s*=\s*1)/i,
    /(OR\s+'1'\s*=\s*'1')/i,
  ];

  return sqlPatterns.some((pattern) => pattern.test(input));
}

/**
 * Feature toggle key validation schema
 *
 * Rules:
 * - 1-100 characters
 * - Only lowercase letters, numbers, and underscores
 * - Cannot start or end with underscore
 * - Cannot contain double underscores
 * - Must not contain SQL injection patterns
 */
export const FeatureToggleKeySchema = z
  .string()
  .min(1, "Feature toggle key is required")
  .max(100, "Feature toggle key must be 100 characters or less")
  .regex(
    /^[a-z0-9_]+$/,
    "Feature toggle key can only contain lowercase letters, numbers, and underscores",
  )
  .refine((key) => !key.includes("__"), {
    message: "Feature toggle key cannot contain double underscores",
  })
  .refine((key) => !key.startsWith("_") && !key.endsWith("_"), {
    message: "Feature toggle key cannot start or end with underscore",
  })
  .refine((key) => !containsSQLInjection(key), {
    message: "Invalid characters detected in feature toggle key",
  });

/**
 * Percentage validation schema
 *
 * Rules:
 * - Integer between 0 and 100
 */
export const PercentageSchema = z.number().int().min(0).max(100);

/**
 * Region validation schema
 *
 * Rules:
 * - Must be one of: US, EU, CN
 */
export const RegionSchema = z.enum(["US", "EU", "CN"], {
  errorMap: () => ({ message: "Region must be one of: US, EU, CN" }),
});

/**
 * Feature toggle category validation schema
 *
 * Rules:
 * - Must be one of the defined categories
 */
export const FeatureToggleCategorySchema = z.enum(
  [
    "AUTHENTICATION",
    "FEATURES",
    "PERFORMANCE",
    "SECURITY",
    "SERVICE_PROVIDER",
    "EXPERIMENTAL",
  ],
  {
    errorMap: () => ({
      message:
        "Category must be one of: AUTHENTICATION, FEATURES, PERFORMANCE, SECURITY, SERVICE_PROVIDER, EXPERIMENTAL",
    }),
  },
);

/**
 * Feature toggle state validation schema
 *
 * Rules:
 * - Must be one of: ENABLED, DISABLED, GRADUAL
 */
export const FeatureToggleStateSchema = z.enum(
  ["ENABLED", "DISABLED", "GRADUAL"],
  {
    errorMap: () => ({
      message: "State must be one of: ENABLED, DISABLED, GRADUAL",
    }),
  },
);

/**
 * Targeting type validation schema
 *
 * Rules:
 * - Must be one of the defined targeting types
 */
export const TargetingTypeSchema = z.enum(
  ["PERCENTAGE", "USER_LIST", "USER_SEGMENT", "REGION", "ALL"],
  {
    errorMap: () => ({
      message:
        "Targeting type must be one of: PERCENTAGE, USER_LIST, USER_SEGMENT, REGION, ALL",
    }),
  },
);

/**
 * Targeting rule validation schema
 *
 * Rules:
 * - Type must be valid targeting type
 * - Value must be a string
 * - Priority must be non-negative integer
 */
export const TargetingSchema = z.object({
  type: TargetingTypeSchema,
  value: z
    .string()
    .max(1000, "Targeting value must be 1000 characters or less"),
  priority: z.number().int().min(0, "Priority must be non-negative"),
});

/**
 * Feature toggle state configuration schema
 *
 * Rules:
 * - Region must be valid
 * - Enabled must be boolean
 * - State must be valid
 * - Percentage must be 0-100
 * - Targeting rules are optional
 */
export const FeatureToggleStateConfigSchema = z.object({
  region: RegionSchema,
  enabled: z.boolean(),
  state: FeatureToggleStateSchema,
  percentage: PercentageSchema,
  targeting: z.array(TargetingSchema).optional(),
});

/**
 * Create feature toggle request schema
 *
 * Rules:
 * - Key must be valid toggle key format
 * - Name must be 1-200 characters
 * - Description is optional, max 1000 characters
 * - Category must be valid
 * - isCritical must be boolean
 * - Initial states are optional array
 */
export const CreateToggleSchema = z
  .object({
    key: FeatureToggleKeySchema,
    name: z
      .string()
      .min(1, "Name is required")
      .max(200, "Name must be 200 characters or less")
      .refine((name) => !containsSQLInjection(name), {
        message: "Invalid characters detected in name",
      }),
    description: z
      .string()
      .max(1000, "Description must be 1000 characters or less")
      .optional()
      .refine((desc) => !desc || !containsSQLInjection(desc), {
        message: "Invalid characters detected in description",
      }),
    category: FeatureToggleCategorySchema,
    isCritical: z.boolean().default(false),
    initialStates: z.array(FeatureToggleStateConfigSchema).optional(),
  })
  .refine(
    (data) => {
      // If description provided, check for SQL injection
      if (data.description) {
        return !containsSQLInjection(data.description);
      }
      return true;
    },
    {
      message: "Invalid characters detected in description",
      path: ["description"],
    },
  );

/**
 * Update feature toggle request schema
 *
 * Rules:
 * - All fields optional
 * - If provided, must match their respective schemas
 */
export const UpdateToggleSchema = z
  .object({
    name: z
      .string()
      .min(1, "Name cannot be empty")
      .max(200, "Name must be 200 characters or less")
      .refine((name) => !containsSQLInjection(name), {
        message: "Invalid characters detected in name",
      })
      .optional(),
    description: z
      .string()
      .max(1000, "Description must be 1000 characters or less")
      .refine((desc) => !desc || !containsSQLInjection(desc), {
        message: "Invalid characters detected in description",
      })
      .optional(),
    category: FeatureToggleCategorySchema.optional(),
    isCritical: z.boolean().optional(),
  })
  .refine(
    (data) => {
      // If description provided, check for SQL injection
      if (data.description) {
        return !containsSQLInjection(data.description);
      }
      return true;
    },
    {
      message: "Invalid characters detected in description",
      path: ["description"],
    },
  );

/**
 * Update feature toggle state request schema
 *
 * Rules:
 * - Region must be valid
 * - Enabled, state, percentage must match their schemas
 * - Targeting rules optional
 */
export const UpdateToggleStateSchema = z.object({
  region: RegionSchema,
  enabled: z.boolean().optional(),
  state: FeatureToggleStateSchema.optional(),
  percentage: PercentageSchema.optional(),
  targeting: z.array(TargetingSchema).optional(),
  reason: z
    .string()
    .max(500, "Reason must be 500 characters or less")
    .optional(),
});

/**
 * Batch evaluate request schema
 *
 * Rules:
 * - Toggles must be array of valid toggle keys
 * - Context must have valid region
 * - UserId optional
 */
export const BatchEvaluateSchema = z.object({
  toggles: z
    .array(FeatureToggleKeySchema)
    .min(1, "At least one toggle key is required")
    .max(100, "Maximum 100 toggles per batch request"),
  context: z.object({
    userId: z.string().max(255).optional(),
    region: RegionSchema,
    userSegment: z.string().max(100).optional(),
  }),
});

/**
 * Public API query parameters schema
 *
 * Rules:
 * - Region optional, must be valid if provided
 * - UserId optional, max 255 characters
 */
export const PublicAPIQuerySchema = z.object({
  region: RegionSchema.optional(),
  userId: z.string().max(255).optional(),
});

/**
 * Type exports for TypeScript inference
 */
export type FeatureToggleKey = z.infer<typeof FeatureToggleKeySchema>;
export type Percentage = z.infer<typeof PercentageSchema>;
export type Region = z.infer<typeof RegionSchema>;
export type FeatureToggleCategory = z.infer<typeof FeatureToggleCategorySchema>;
export type FeatureToggleState = z.infer<typeof FeatureToggleStateSchema>;
export type TargetingType = z.infer<typeof TargetingTypeSchema>;
export type Targeting = z.infer<typeof TargetingSchema>;
export type FeatureToggleStateConfig = z.infer<
  typeof FeatureToggleStateConfigSchema
>;
export type CreateToggleInput = z.infer<typeof CreateToggleSchema>;
export type UpdateToggleInput = z.infer<typeof UpdateToggleSchema>;
export type UpdateToggleStateInput = z.infer<typeof UpdateToggleStateSchema>;
export type BatchEvaluateInput = z.infer<typeof BatchEvaluateSchema>;
export type PublicAPIQuery = z.infer<typeof PublicAPIQuerySchema>;
