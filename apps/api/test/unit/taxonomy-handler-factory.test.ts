/**
 * Unit Tests: taxonomy-handler-factory
 *
 * Security contract: createTaxonomyHandler must return null whenever the
 * request has no authenticated tenant context. Callers must respond 401 in
 * that case — there must be no fallback to a default tenant.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock refs — must be declared before any vi.mock() calls.
// ---------------------------------------------------------------------------
const { authMock, getWrappedDbMock, TaxonomyHandlerMock, wrappedDbSentinel } =
  vi.hoisted(() => {
    const wrappedDbSentinel = { __sentinel: "wrapped-db" };

    const authMock = vi.fn();
    const getWrappedDbMock = vi.fn(() => wrappedDbSentinel);

    // Constructor that records the args it was called with.
    const TaxonomyHandlerMock = vi.fn(function (
      this: any,
      wrappedDb: unknown,
      tenantId: unknown,
      cacheKv: unknown,
    ) {
      this._args = { wrappedDb, tenantId, cacheKv };
    });

    return { authMock, getWrappedDbMock, TaxonomyHandlerMock, wrappedDbSentinel };
  });

// ---------------------------------------------------------------------------
// Module mocks — specifiers must match exactly what the source imports.
// ---------------------------------------------------------------------------
vi.mock("../../src/lib/auth/auth-middleware.js", () => ({
  authMiddleware: authMock,
}));

vi.mock("../../src/lib/database-wrapper-helper.js", () => ({
  getWrappedDatabase: getWrappedDbMock,
}));

vi.mock("../../src/lib/taxonomy-handler.js", () => ({
  TaxonomyHandler: TaxonomyHandlerMock,
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER the mocks are registered.
// ---------------------------------------------------------------------------
import { createTaxonomyHandler } from "../../src/lib/taxonomy-handler-factory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const makeRequest = () =>
  new Request("https://api.example.com/api/taxonomy/dimensions");

const makeEnv = () =>
  ({ TAXONOMY_CACHE_KV: { __kv: "cache" } }) as any;

const REGION = "eu-central-1";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("createTaxonomyHandler — security contract", () => {
  let request: Request;
  let env: any;

  beforeEach(() => {
    vi.clearAllMocks();
    request = makeRequest();
    env = makeEnv();
  });

  it("passes (request, env) to authMiddleware", async () => {
    authMock.mockResolvedValue(null);

    await createTaxonomyHandler(request, env, REGION);

    expect(authMock).toHaveBeenCalledOnce();
    expect(authMock).toHaveBeenCalledWith(request, env);
  });

  describe("unauthenticated → null (no side-effects)", () => {
    it("returns null when authMiddleware resolves null", async () => {
      authMock.mockResolvedValue(null);

      const result = await createTaxonomyHandler(request, env, REGION);

      expect(result).toBeNull();
      expect(getWrappedDbMock).not.toHaveBeenCalled();
      expect(TaxonomyHandlerMock).not.toHaveBeenCalled();
    });
  });

  describe("authenticated but no activeTenantId → null (security contract)", () => {
    it("returns null when activeTenantId is undefined — no default-tenant fallback", async () => {
      // Auth succeeded but no active tenant was resolved.
      authMock.mockResolvedValue({ userId: "user-1" });

      const result = await createTaxonomyHandler(request, env, REGION);

      expect(result).toBeNull();
      expect(getWrappedDbMock).not.toHaveBeenCalled();
      expect(TaxonomyHandlerMock).not.toHaveBeenCalled();
    });

    it("returns null when activeTenantId is explicitly null", async () => {
      authMock.mockResolvedValue({ userId: "user-1", activeTenantId: null });

      const result = await createTaxonomyHandler(request, env, REGION);

      expect(result).toBeNull();
      expect(getWrappedDbMock).not.toHaveBeenCalled();
      expect(TaxonomyHandlerMock).not.toHaveBeenCalled();
    });

    it("returns null when activeTenantId is an empty string", async () => {
      authMock.mockResolvedValue({ userId: "user-1", activeTenantId: "" });

      const result = await createTaxonomyHandler(request, env, REGION);

      expect(result).toBeNull();
      expect(getWrappedDbMock).not.toHaveBeenCalled();
      expect(TaxonomyHandlerMock).not.toHaveBeenCalled();
    });
  });

  describe("authenticated with activeTenantId → constructs handler", () => {
    it("returns a TaxonomyHandler instance when auth succeeds with a tenant", async () => {
      authMock.mockResolvedValue({ userId: "user-1", activeTenantId: "tenant-abc" });

      const result = await createTaxonomyHandler(request, env, REGION);

      expect(result).toBeInstanceOf(TaxonomyHandlerMock);
    });

    it("calls getWrappedDatabase with (region, env, request)", async () => {
      authMock.mockResolvedValue({ userId: "user-1", activeTenantId: "tenant-abc" });

      await createTaxonomyHandler(request, env, REGION);

      expect(getWrappedDbMock).toHaveBeenCalledOnce();
      expect(getWrappedDbMock).toHaveBeenCalledWith(REGION, env, request);
    });

    it("constructs TaxonomyHandler with (wrappedDb sentinel, activeTenantId, TAXONOMY_CACHE_KV)", async () => {
      authMock.mockResolvedValue({ userId: "user-1", activeTenantId: "tenant-abc" });

      await createTaxonomyHandler(request, env, REGION);

      expect(TaxonomyHandlerMock).toHaveBeenCalledOnce();
      expect(TaxonomyHandlerMock).toHaveBeenCalledWith(
        wrappedDbSentinel,
        "tenant-abc",
        env.TAXONOMY_CACHE_KV,
      );
    });
  });
});
