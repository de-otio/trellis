import { describe, expect, it, vi } from "vitest";
import { createExtensionContext } from "../../src/lib/extension-context.js";
import { CORE_SECRET_ENV_KEYS } from "../../src/lib/extension-config-keys.js";
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
  const tid = (t: string) => t as any;

  it("exposes ONLY the tenant()-scoped surface, not a raw delegate bag (O-1 §5.3)", () => {
    const ctx = createExtensionContext(makeExtension(), mockEnv, mockPrisma, mockGraph);

    // The raw unscoped delegate bag is gone — data is reachable only via tenant().
    expect(typeof ctx.db.tenant).toBe("function");
    expect((ctx.db as any).entity).toBeUndefined();
    expect((ctx.db as any).post).toBeUndefined();

    const scoped = ctx.db.tenant(tid("t-acme"));
    // Tenant-carrying core delegates expose the op surface.
    expect(typeof scoped.entity.findMany).toBe("function");
    expect(typeof scoped.post.create).toBe("function");
    // No raw-SQL escape hatch: $queryRaw/$executeRaw are not callable client
    // methods on the scoped surface (the proxy exposes only tenant-bound
    // delegate objects, never the raw-SQL functions).
    expect(typeof (scoped as any).$queryRaw).not.toBe("function");
    expect(typeof (scoped as any).$executeRaw).not.toBe("function");
  });

  it("exposes discover() honoring the extension's crossTenantRead declaration (05a Part B)", async () => {
    const ext = makeExtension({ crossTenantRead: ["post", "taxonomyTaxon"] });
    const ctx = createExtensionContext(ext, mockEnv, mockPrisma, mockGraph, "EU");

    expect(typeof ctx.db.discover).toBe("function");
    const d = ctx.db.discover("product-reco");
    // A declared model resolves to a working read-only delegate...
    await d.post.findMany();
    expect(mockPrisma.post.findMany).toHaveBeenCalled();
    // ...an undeclared model is blocked, even though it is in the core allow-list.
    expect(() => (d as any).productTaxonomyTag.findMany()).toThrow();
    // ...and a never-allowed model is blocked.
    expect(() => (d as any).user.findMany()).toThrow();
  });

  it("blocks security-sensitive / non-tenant models fail-closed on the scoped surface", async () => {
    const ctx = createExtensionContext(makeExtension(), mockEnv, mockPrisma, mockGraph);
    const scoped = ctx.db.tenant(tid("t-acme"));
    // user / securityEvent / activity are not on the scoped surface — their ops reject.
    await expect(scoped.user.findMany({})).rejects.toThrow();
    await expect((scoped as any).securityEvent.findMany({})).rejects.toThrow();
    await expect(scoped.activity.findMany({})).rejects.toThrow();
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

  // ── Sweep C8 ───────────────────────────────────────────────────────────────
  //
  // Every test above checks a key the extension did NOT declare, which was
  // never the hole: `extractExtensionConfig` walked the extension's own
  // `configSchema.shape` and returned `process.env[key]` for each entry. So
  // `z.object({ SESSION_SECRET: z.string() })` put the session-signing secret
  // on `ctx.config` — one line, no `.passthrough()`, no `.transform()` — while
  // the package doc comment said "Core secrets … are never exposed".
  //
  // `validateExtensions` refuses that manifest at boot. This pins the second
  // half: a context built WITHOUT validation (this call, an embedder, a future
  // dynamic load) still hands over nothing. Fails on the old code.
  describe("declared core secrets are still not readable (C8)", () => {
    it("does not expose SESSION_SECRET even when the schema declares it", () => {
      const original = process.env.SESSION_SECRET;
      process.env.SESSION_SECRET = "live-session-secret-at-least-32-chars!!";
      try {
        const ext = makeExtension({
          configSchema: z.object({ SESSION_SECRET: z.string() }),
        });
        const ctx = createExtensionContext(ext, mockEnv, mockPrisma, mockGraph);
        expect(ctx.config.SESSION_SECRET).toBeUndefined();
        expect(Object.values(ctx.config)).not.toContain(
          "live-session-secret-at-least-32-chars!!",
        );
      } finally {
        if (original === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = original;
      }
    });

    it("does not expose any key on the core-secret list", () => {
      const sentinel = "core-secret-value-that-must-not-cross-the-seam";
      const saved = new Map<string, string | undefined>();
      for (const key of CORE_SECRET_ENV_KEYS) {
        saved.set(key, process.env[key]);
        process.env[key] = sentinel;
      }
      try {
        const shape = Object.fromEntries(
          CORE_SECRET_ENV_KEYS.map((k) => [k, z.string().optional()]),
        );
        const ext = makeExtension({ configSchema: z.object(shape) });
        const ctx = createExtensionContext(ext, mockEnv, mockPrisma, mockGraph);
        expect(ctx.config).toEqual({});
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    it("keeps the extension's own keys while dropping the core ones", () => {
      const saved = process.env.SESSION_SECRET;
      const savedOwn = process.env.DOG_REGISTRY_URL;
      process.env.SESSION_SECRET = "live-session-secret-at-least-32-chars!!";
      process.env.DOG_REGISTRY_URL = "https://registry.example.com";
      try {
        const ext = makeExtension({
          configSchema: z.object({
            SESSION_SECRET: z.string().optional(),
            DOG_REGISTRY_URL: z.string().optional(),
          }),
        });
        const ctx = createExtensionContext(ext, mockEnv, mockPrisma, mockGraph);
        expect(ctx.config).toEqual({
          DOG_REGISTRY_URL: "https://registry.example.com",
        });
      } finally {
        if (saved === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = saved;
        if (savedOwn === undefined) delete process.env.DOG_REGISTRY_URL;
        else process.env.DOG_REGISTRY_URL = savedOwn;
      }
    });
  });
});
