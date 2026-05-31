import { describe, expect, it, vi } from "vitest";
import { createExtensionContext } from "../../src/lib/extension-context.js";
import type { TrellisExtension } from "@de-otio/trellis-extension-api";
import { z } from "zod";

function makeExtension(overrides: Partial<TrellisExtension> = {}): TrellisExtension {
  return {
    id: "dog",
    terminology: { entity: "dog", entityPlural: "dogs" },
    routes: [],
    metadataSchema: z.object({}),
    ...overrides,
  };
}

const mockPrisma = {
  entity: { findMany: vi.fn() },
  post: { findMany: vi.fn() },
  postEntity: { findMany: vi.fn() },
  postMedia: { findMany: vi.fn() },
  follow: { findMany: vi.fn() },
  taxonomyTaxon: { findMany: vi.fn() },
  taxonomyCategory: { findMany: vi.fn() },
  taxonomyDimension: { findMany: vi.fn() },
  productTaxonomyTag: { findMany: vi.fn() },
  activity: { findMany: vi.fn() },
  // Security-sensitive tables that should NOT be exposed
  user: { findMany: vi.fn() },
  securityEvent: { findMany: vi.fn() },
  featureToggle: { findMany: vi.fn() },
  mfaEnrollment: { findMany: vi.fn() },
  encryptionKey: { findMany: vi.fn() },
};

const mockGraph = {
  getRelationship: vi.fn(),
  getRelationships: vi.fn(),
  getRelationshipGraph: vi.fn(),
  getCircleMembers: vi.fn(),
  getVisiblePostIds: vi.fn(),
  getGlanceItems: vi.fn(),
  getDepthPostIds: vi.fn(),
  getCircleStatus: vi.fn(),
  getCircleEntityStatus: vi.fn(),
  getEntityRelationships: vi.fn(),
  getPendingEntityRelationships: vi.fn(),
  discoverByGraph: vi.fn(),
  discoverNearby: vi.fn(),
  getRecommendations: vi.fn(),
} as any;

const mockEnv = {
  APP_DOMAIN: "example.com",
  APP_URL: "https://api.example.com",
  STAGE: "dev",
  SESSION_SECRET: "super-secret-do-not-expose-to-extensions!!",
  DATABASE_URL: "postgresql://user:password@host:5432/db",
  OPENAI_API_KEY: "sk-secret-key",
  AWS_ACCESS_KEY_ID: "AKIA-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
} as any;

describe("createExtensionContext", () => {
  it("exposes only extension-safe database tables", () => {
    const ctx = createExtensionContext(makeExtension(), mockEnv, mockPrisma, mockGraph);

    // Should be accessible
    expect(ctx.db.entity).toBeDefined();
    expect(ctx.db.post).toBeDefined();
    expect(ctx.db.postEntity).toBeDefined();
    expect(ctx.db.postMedia).toBeDefined();
    expect(ctx.db.taxonomyTaxon).toBeDefined();
    expect(ctx.db.taxonomyCategory).toBeDefined();
    expect(ctx.db.taxonomyDimension).toBeDefined();
    expect(ctx.db.productTaxonomyTag).toBeDefined();
    expect(ctx.db.activity).toBeDefined();

    // Should NOT be accessible
    expect((ctx.db as any).user).toBeUndefined();
    expect((ctx.db as any).securityEvent).toBeUndefined();
    expect((ctx.db as any).featureToggle).toBeUndefined();
    expect((ctx.db as any).mfaEnrollment).toBeUndefined();
    expect((ctx.db as any).encryptionKey).toBeUndefined();
  });

  it("exposes app domain and URL", () => {
    const ctx = createExtensionContext(makeExtension(), mockEnv, mockPrisma, mockGraph);
    expect(ctx.appDomain).toBe("example.com");
    expect(ctx.appUrl).toBe("https://api.example.com");
    expect(ctx.stage).toBe("dev");
  });

  it("does NOT expose SESSION_SECRET", () => {
    const ctx = createExtensionContext(makeExtension(), mockEnv, mockPrisma, mockGraph);
    expect((ctx as any).SESSION_SECRET).toBeUndefined();
    expect(ctx.config.SESSION_SECRET).toBeUndefined();
  });

  it("does NOT expose DATABASE_URL", () => {
    const ctx = createExtensionContext(makeExtension(), mockEnv, mockPrisma, mockGraph);
    expect((ctx as any).DATABASE_URL).toBeUndefined();
    expect(ctx.config.DATABASE_URL).toBeUndefined();
  });

  it("does NOT expose API keys", () => {
    const ctx = createExtensionContext(makeExtension(), mockEnv, mockPrisma, mockGraph);
    expect(ctx.config.OPENAI_API_KEY).toBeUndefined();
    expect(ctx.config.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(ctx.config.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("exposes read-only graph service methods", () => {
    const ctx = createExtensionContext(makeExtension(), mockEnv, mockPrisma, mockGraph);
    expect(typeof ctx.graphService.getRelationship).toBe("function");
    expect(typeof ctx.graphService.getCircleMembers).toBe("function");
    expect(typeof ctx.graphService.discoverByGraph).toBe("function");
    // Write methods must not be exposed
    expect((ctx.graphService as any).createRelationship).toBeUndefined();
    expect((ctx.graphService as any).removeRelationship).toBeUndefined();
    expect((ctx.graphService as any).syncUser).toBeUndefined();
  });

  it("extracts only declared config keys from process.env", () => {
    const originalEnv = process.env.DOG_BREED_API_KEY;
    process.env.DOG_BREED_API_KEY = "test-breed-key";

    const ext = makeExtension({
      configSchema: z.object({
        DOG_BREED_API_KEY: z.string().optional(),
      }),
    });

    const ctx = createExtensionContext(ext, mockEnv, mockPrisma, mockGraph);
    expect(ctx.config.DOG_BREED_API_KEY).toBe("test-breed-key");
    // Core secrets not leaked even though they're in process.env
    expect(ctx.config.SESSION_SECRET).toBeUndefined();

    // Cleanup
    if (originalEnv === undefined) {
      delete process.env.DOG_BREED_API_KEY;
    } else {
      process.env.DOG_BREED_API_KEY = originalEnv;
    }
  });

  it("returns empty config when no configSchema is set", () => {
    const ctx = createExtensionContext(makeExtension(), mockEnv, mockPrisma, mockGraph);
    expect(ctx.config).toEqual({});
  });
});
