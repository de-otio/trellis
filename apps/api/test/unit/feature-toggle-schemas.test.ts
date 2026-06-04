/**
 * Unit Tests for Feature Toggle Validation Schemas
 *
 * Tests all validation schemas to ensure they properly:
 * - Accept valid input
 * - Reject invalid input
 * - Prevent SQL injection
 * - Enforce length limits
 * - Validate enums and types
 */

import { describe, it, expect } from "vitest";
import {
  FeatureToggleKeySchema,
  PercentageSchema,
  RegionSchema,
  FeatureToggleCategorySchema,
  FeatureToggleStateSchema,
  TargetingTypeSchema,
  TargetingSchema,
  FeatureToggleStateConfigSchema,
  CreateToggleSchema,
  UpdateToggleSchema,
  UpdateToggleStateSchema,
  BatchEvaluateSchema,
  PublicAPIQuerySchema,
} from "../../src/lib/validation/feature-toggle-schemas.js";

describe("FeatureToggleKeySchema", () => {
  it("should accept valid toggle keys", () => {
    expect(FeatureToggleKeySchema.parse("valid_key")).toBe("valid_key");
    expect(FeatureToggleKeySchema.parse("key123")).toBe("key123");
    expect(FeatureToggleKeySchema.parse("a")).toBe("a");
    expect(FeatureToggleKeySchema.parse("a".repeat(100))).toBe("a".repeat(100));
  });

  it("should reject empty strings", () => {
    expect(() => FeatureToggleKeySchema.parse("")).toThrow();
  });

  it("should reject keys longer than 100 characters", () => {
    expect(() => FeatureToggleKeySchema.parse("a".repeat(101))).toThrow();
  });

  it("should reject uppercase letters", () => {
    expect(() => FeatureToggleKeySchema.parse("InvalidKey")).toThrow();
  });

  it("should reject special characters", () => {
    expect(() => FeatureToggleKeySchema.parse("invalid-key")).toThrow();
    expect(() => FeatureToggleKeySchema.parse("invalid.key")).toThrow();
    expect(() => FeatureToggleKeySchema.parse("invalid key")).toThrow();
  });

  it("should reject keys starting with underscore", () => {
    expect(() => FeatureToggleKeySchema.parse("_invalid")).toThrow();
  });

  it("should reject keys ending with underscore", () => {
    expect(() => FeatureToggleKeySchema.parse("invalid_")).toThrow();
  });

  it("should reject double underscores", () => {
    expect(() => FeatureToggleKeySchema.parse("invalid__key")).toThrow();
  });

  it("should reject SQL injection attempts", () => {
    expect(() =>
      FeatureToggleKeySchema.parse("'; DROP TABLE feature_toggles; --"),
    ).toThrow();
    expect(() => FeatureToggleKeySchema.parse("1' OR '1'='1")).toThrow();
    expect(() => FeatureToggleKeySchema.parse("SELECT * FROM")).toThrow();
  });
});

describe("PercentageSchema", () => {
  it("should accept valid percentages", () => {
    expect(PercentageSchema.parse(0)).toBe(0);
    expect(PercentageSchema.parse(50)).toBe(50);
    expect(PercentageSchema.parse(100)).toBe(100);
  });

  it("should reject negative numbers", () => {
    expect(() => PercentageSchema.parse(-1)).toThrow();
  });

  it("should reject numbers greater than 100", () => {
    expect(() => PercentageSchema.parse(101)).toThrow();
  });

  it("should reject non-integers", () => {
    expect(() => PercentageSchema.parse(50.5)).toThrow();
  });

  it("should reject non-numbers", () => {
    expect(() => PercentageSchema.parse("50")).toThrow();
    expect(() => PercentageSchema.parse(null)).toThrow();
    expect(() => PercentageSchema.parse(undefined)).toThrow();
  });
});

describe("RegionSchema", () => {
  it("should accept valid regions", () => {
    expect(RegionSchema.parse("US")).toBe("US");
    expect(RegionSchema.parse("EU")).toBe("EU");
    expect(RegionSchema.parse("CN")).toBe("CN");
  });

  it("should reject invalid regions", () => {
    expect(() => RegionSchema.parse("us")).toThrow();
    expect(() => RegionSchema.parse("INVALID")).toThrow();
    expect(() => RegionSchema.parse("")).toThrow();
  });
});

describe("FeatureToggleCategorySchema", () => {
  it("should accept valid categories", () => {
    expect(FeatureToggleCategorySchema.parse("AUTHENTICATION")).toBe(
      "AUTHENTICATION",
    );
    expect(FeatureToggleCategorySchema.parse("FEATURES")).toBe("FEATURES");
    expect(FeatureToggleCategorySchema.parse("PERFORMANCE")).toBe(
      "PERFORMANCE",
    );
    expect(FeatureToggleCategorySchema.parse("SECURITY")).toBe("SECURITY");
    expect(FeatureToggleCategorySchema.parse("SERVICE_PROVIDER")).toBe(
      "SERVICE_PROVIDER",
    );
    expect(FeatureToggleCategorySchema.parse("EXPERIMENTAL")).toBe(
      "EXPERIMENTAL",
    );
  });

  it("should reject invalid categories", () => {
    expect(() => FeatureToggleCategorySchema.parse("INVALID")).toThrow();
    expect(() => FeatureToggleCategorySchema.parse("")).toThrow();
  });
});

describe("FeatureToggleStateSchema", () => {
  it("should accept valid states", () => {
    expect(FeatureToggleStateSchema.parse("ENABLED")).toBe("ENABLED");
    expect(FeatureToggleStateSchema.parse("DISABLED")).toBe("DISABLED");
    expect(FeatureToggleStateSchema.parse("GRADUAL")).toBe("GRADUAL");
  });

  it("should reject invalid states", () => {
    expect(() => FeatureToggleStateSchema.parse("enabled")).toThrow();
    expect(() => FeatureToggleStateSchema.parse("INVALID")).toThrow();
  });
});

describe("TargetingTypeSchema", () => {
  it("should accept valid targeting types", () => {
    expect(TargetingTypeSchema.parse("PERCENTAGE")).toBe("PERCENTAGE");
    expect(TargetingTypeSchema.parse("USER_LIST")).toBe("USER_LIST");
    expect(TargetingTypeSchema.parse("USER_SEGMENT")).toBe("USER_SEGMENT");
    expect(TargetingTypeSchema.parse("REGION")).toBe("REGION");
    expect(TargetingTypeSchema.parse("ALL")).toBe("ALL");
  });

  it("should reject invalid targeting types", () => {
    expect(() => TargetingTypeSchema.parse("INVALID")).toThrow();
  });
});

describe("TargetingSchema", () => {
  it("should accept valid targeting rules", () => {
    expect(
      TargetingSchema.parse({
        type: "PERCENTAGE",
        value: "50",
        priority: 0,
      }),
    ).toEqual({
      type: "PERCENTAGE",
      value: "50",
      priority: 0,
    });
  });

  it("should reject invalid targeting rules", () => {
    expect(() =>
      TargetingSchema.parse({
        type: "INVALID",
        value: "50",
        priority: 0,
      }),
    ).toThrow();

    expect(() =>
      TargetingSchema.parse({
        type: "PERCENTAGE",
        value: "a".repeat(1001),
        priority: 0,
      }),
    ).toThrow();

    expect(() =>
      TargetingSchema.parse({
        type: "PERCENTAGE",
        value: "50",
        priority: -1,
      }),
    ).toThrow();
  });
});

describe("FeatureToggleStateConfigSchema", () => {
  it("should accept valid state configs", () => {
    expect(
      FeatureToggleStateConfigSchema.parse({
        region: "US",
        enabled: true,
        state: "ENABLED",
        percentage: 100,
      }),
    ).toEqual({
      region: "US",
      enabled: true,
      state: "ENABLED",
      percentage: 100,
    });
  });

  it("should reject invalid state configs", () => {
    expect(() =>
      FeatureToggleStateConfigSchema.parse({
        region: "INVALID",
        enabled: true,
        state: "ENABLED",
        percentage: 100,
      }),
    ).toThrow();

    expect(() =>
      FeatureToggleStateConfigSchema.parse({
        region: "US",
        enabled: "true",
        state: "ENABLED",
        percentage: 100,
      }),
    ).toThrow();

    expect(() =>
      FeatureToggleStateConfigSchema.parse({
        region: "US",
        enabled: true,
        state: "ENABLED",
        percentage: 150,
      }),
    ).toThrow();
  });
});

describe("CreateToggleSchema", () => {
  it("should accept valid create toggle requests", () => {
    expect(
      CreateToggleSchema.parse({
        key: "new_feature",
        name: "New Feature",
        category: "FEATURES",
        isCritical: false,
      }),
    ).toMatchObject({
      key: "new_feature",
      name: "New Feature",
      category: "FEATURES",
      isCritical: false,
    });
  });

  it("should accept create toggle with description", () => {
    expect(
      CreateToggleSchema.parse({
        key: "new_feature",
        name: "New Feature",
        description: "A new feature",
        category: "FEATURES",
        isCritical: false,
      }),
    ).toMatchObject({
      key: "new_feature",
      name: "New Feature",
      description: "A new feature",
      category: "FEATURES",
      isCritical: false,
    });
  });

  it("should reject invalid create toggle requests", () => {
    expect(() =>
      CreateToggleSchema.parse({
        key: "INVALID-KEY",
        name: "New Feature",
        category: "FEATURES",
      }),
    ).toThrow();

    expect(() =>
      CreateToggleSchema.parse({
        key: "new_feature",
        name: "",
        category: "FEATURES",
      }),
    ).toThrow();

    expect(() =>
      CreateToggleSchema.parse({
        key: "new_feature",
        name: "New Feature",
        category: "INVALID",
      }),
    ).toThrow();
  });

  it("should reject SQL injection in name", () => {
    expect(() =>
      CreateToggleSchema.parse({
        key: "new_feature",
        name: "'; DROP TABLE feature_toggles; --",
        category: "FEATURES",
      }),
    ).toThrow();
  });

  it("should reject SQL injection in description", () => {
    expect(() =>
      CreateToggleSchema.parse({
        key: "new_feature",
        name: "New Feature",
        description: "'; DROP TABLE feature_toggles; --",
        category: "FEATURES",
      }),
    ).toThrow();
  });
});

describe("UpdateToggleSchema", () => {
  it("should accept valid update requests", () => {
    expect(
      UpdateToggleSchema.parse({
        name: "Updated Name",
      }),
    ).toMatchObject({
      name: "Updated Name",
    });

    expect(
      UpdateToggleSchema.parse({
        description: "Updated description",
      }),
    ).toMatchObject({
      description: "Updated description",
    });
  });

  it("should accept empty update (all fields optional)", () => {
    expect(UpdateToggleSchema.parse({})).toEqual({});
  });

  it("should reject invalid update requests", () => {
    expect(() =>
      UpdateToggleSchema.parse({
        name: "",
      }),
    ).toThrow();

    expect(() =>
      UpdateToggleSchema.parse({
        category: "INVALID",
      }),
    ).toThrow();
  });
});

describe("UpdateToggleStateSchema", () => {
  it("should accept valid state update requests", () => {
    expect(
      UpdateToggleStateSchema.parse({
        region: "US",
        enabled: true,
        state: "ENABLED",
        percentage: 100,
      }),
    ).toMatchObject({
      region: "US",
      enabled: true,
      state: "ENABLED",
      percentage: 100,
    });
  });

  it("should accept partial updates", () => {
    expect(
      UpdateToggleStateSchema.parse({
        region: "US",
        percentage: 50,
      }),
    ).toMatchObject({
      region: "US",
      percentage: 50,
    });
  });

  it("should reject invalid state updates", () => {
    expect(() =>
      UpdateToggleStateSchema.parse({
        region: "INVALID",
      }),
    ).toThrow();

    expect(() =>
      UpdateToggleStateSchema.parse({
        region: "US",
        percentage: 150,
      }),
    ).toThrow();
  });
});

describe("BatchEvaluateSchema", () => {
  it("should accept valid batch evaluate requests", () => {
    expect(
      BatchEvaluateSchema.parse({
        toggles: ["feature1", "feature2"],
        context: {
          region: "US",
        },
      }),
    ).toMatchObject({
      toggles: ["feature1", "feature2"],
      context: {
        region: "US",
      },
    });
  });

  it("should accept batch evaluate with userId", () => {
    expect(
      BatchEvaluateSchema.parse({
        toggles: ["feature1"],
        context: {
          region: "US",
          userId: "user123",
        },
      }),
    ).toMatchObject({
      toggles: ["feature1"],
      context: {
        region: "US",
        userId: "user123",
      },
    });
  });

  it("should reject empty toggles array", () => {
    expect(() =>
      BatchEvaluateSchema.parse({
        toggles: [],
        context: {
          region: "US",
        },
      }),
    ).toThrow();
  });

  it("should reject too many toggles", () => {
    expect(() =>
      BatchEvaluateSchema.parse({
        toggles: Array(101).fill("feature"),
        context: {
          region: "US",
        },
      }),
    ).toThrow();
  });

  it("should reject invalid region in context", () => {
    expect(() =>
      BatchEvaluateSchema.parse({
        toggles: ["feature1"],
        context: {
          region: "INVALID",
        },
      }),
    ).toThrow();
  });
});

describe("PublicAPIQuerySchema", () => {
  it("should accept valid query parameters", () => {
    expect(
      PublicAPIQuerySchema.parse({
        region: "US",
      }),
    ).toMatchObject({
      region: "US",
    });

    expect(
      PublicAPIQuerySchema.parse({
        region: "US",
        userId: "user123",
      }),
    ).toMatchObject({
      region: "US",
      userId: "user123",
    });

    expect(PublicAPIQuerySchema.parse({})).toEqual({});
  });

  it("should reject invalid query parameters", () => {
    expect(() =>
      PublicAPIQuerySchema.parse({
        region: "INVALID",
      }),
    ).toThrow();
  });
});
