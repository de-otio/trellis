/**
 * Unit Tests: auth-middleware ↔ JIT claims fallback wiring (WS-0, plan 016).
 *
 * The JIT resolution itself is covered in identity/jit-claims.test.ts; these
 * tests assert the middleware enters the fallback exactly when the verified
 * token lacks userId/activeTenantId, builds the AuthContext from the resolved
 * claims, and still fails closed on a null/malformed resolution.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authMiddleware,
  extractVerifiedTenantId,
} from "../../../src/lib/auth/auth-middleware.js";

const USER_CUID = "cusr1234567890abcdefghijk";
const TENANT_CUID = "ctnt1234567890abcdefghijk";

const { mockVerify, mockResolveJit } = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockResolveJit: vi.fn(),
}));

vi.mock("../../../src/lib/auth/cognito-jwt", () => ({
  extractBearerToken: (header: string | null) => {
    if (!header?.startsWith("Bearer ")) return null;
    return header.slice(7);
  },
  verifyJwt: (...args: unknown[]) => mockVerify(...args),
}));

vi.mock("../../../src/lib/identity/jit-claims", () => ({
  resolveJitClaims: (...args: unknown[]) => mockResolveJit(...args),
}));

const mockEnv = { DATABASE_URL: "postgresql://test" } as any;

function request(): Request {
  return new Request("https://api.example.com/api/tenants", {
    headers: { Authorization: "Bearer valid-token" },
  });
}

const CLAIMLESS_TOKEN = { sub: "kc-sub", username: "u@example.com", email: "u@example.com" };

const JIT_CLAIMS = {
  userId: USER_CUID,
  globalRole: "END_USER",
  activeTenantId: TENANT_CUID,
  tenantSlug: "personal-slug",
  tenantRole: "OWNER",
  handle: "hondo",
};

describe("authMiddleware JIT fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the AuthContext from JIT-resolved claims when the token carries none", async () => {
    mockVerify.mockResolvedValue(CLAIMLESS_TOKEN);
    mockResolveJit.mockResolvedValue(JIT_CLAIMS);

    const result = await authMiddleware(request(), mockEnv);

    expect(mockResolveJit).toHaveBeenCalledWith(CLAIMLESS_TOKEN, mockEnv);
    expect(result).toMatchObject({
      sub: "kc-sub",
      userId: USER_CUID,
      activeTenantId: TENANT_CUID,
      globalRole: "END_USER",
      tenantRole: "OWNER",
      tenantSlug: "personal-slug",
      handle: "hondo",
    });
  });

  it("does not enter the fallback when the token already carries the claims", async () => {
    mockVerify.mockResolvedValue({
      ...CLAIMLESS_TOKEN,
      userId: USER_CUID,
      activeTenantId: TENANT_CUID,
    });

    const result = await authMiddleware(request(), mockEnv);

    expect(mockResolveJit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ userId: USER_CUID });
  });

  it("returns null when the JIT resolution yields nothing (Cognito or failure)", async () => {
    mockVerify.mockResolvedValue(CLAIMLESS_TOKEN);
    mockResolveJit.mockResolvedValue(null);

    expect(await authMiddleware(request(), mockEnv)).toBeNull();
  });

  it("still rejects malformed (non-cuid) JIT claim values", async () => {
    mockVerify.mockResolvedValue(CLAIMLESS_TOKEN);
    mockResolveJit.mockResolvedValue({ ...JIT_CLAIMS, activeTenantId: "not-a-cuid!" });

    expect(await authMiddleware(request(), mockEnv)).toBeNull();
  });

  it("least-privilege defaults apply when JIT roles come back empty", async () => {
    mockVerify.mockResolvedValue(CLAIMLESS_TOKEN);
    mockResolveJit.mockResolvedValue({ ...JIT_CLAIMS, globalRole: "", tenantRole: "" });

    const result = await authMiddleware(request(), mockEnv);

    expect(result).toMatchObject({ globalRole: "END_USER", tenantRole: "GUEST" });
  });
});

describe("extractVerifiedTenantId JIT fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the ambient tenant id via JIT when the claim is missing", async () => {
    mockVerify.mockResolvedValue(CLAIMLESS_TOKEN);
    mockResolveJit.mockResolvedValue(JIT_CLAIMS);

    expect(await extractVerifiedTenantId(request(), mockEnv)).toBe(TENANT_CUID);
  });

  it("returns the token claim without entering the fallback when present", async () => {
    mockVerify.mockResolvedValue({ ...CLAIMLESS_TOKEN, activeTenantId: TENANT_CUID });

    expect(await extractVerifiedTenantId(request(), mockEnv)).toBe(TENANT_CUID);
    expect(mockResolveJit).not.toHaveBeenCalled();
  });

  it("returns null when the JIT resolution yields nothing", async () => {
    mockVerify.mockResolvedValue(CLAIMLESS_TOKEN);
    mockResolveJit.mockResolvedValue(null);

    expect(await extractVerifiedTenantId(request(), mockEnv)).toBeNull();
  });
});
