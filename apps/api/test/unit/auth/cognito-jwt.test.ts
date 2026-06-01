/**
 * Unit Tests: cognito-jwt
 *
 * Covers:
 *   - extractBearerToken (pure function)
 *   - verifyCognitoJwt claim narrowing
 *   - verifyCognitoJwt retry-once on MultiPoolVerifierError (S1.5)
 *   - No-retry on generic errors
 *   - Lazy singleton creation and caching
 *   - 24-hour JWKS refresh
 *   - Missing env-var guard
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mock factories so they're available before vi.mock() factory runs
// ---------------------------------------------------------------------------
const { verifyMock, createVerifierMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  createVerifierMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @de-otio/vestibulum — MultiPoolVerifierError MUST be a real Error
// subclass so `instanceof` works in the source's retry branch.
// ---------------------------------------------------------------------------
vi.mock("@de-otio/vestibulum", () => ({
  createMultiPoolVerifier: createVerifierMock,
  MultiPoolVerifierError: class MultiPoolVerifierError extends Error {
    constructor(message?: string) {
      super(message ?? "MultiPoolVerifierError");
      this.name = "MultiPoolVerifierError";
    }
  },
}));

import {
  extractBearerToken,
  resetVerifier,
  verifyCognitoJwt,
} from "../../../src/lib/auth/cognito-jwt.js";
import { MultiPoolVerifierError } from "@de-otio/vestibulum";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid-looking claims returned by vestibulum verify */
function makeClaims(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sub: "user-sub-uuid-1234",
    "cognito:username": "dummy-username",
    email: "user@example.com",
    ...overrides,
  };
}

function setupVerifySuccess(claims: Record<string, unknown> = makeClaims()) {
  verifyMock.mockResolvedValue({ claims });
}

// ---------------------------------------------------------------------------
// Global beforeEach / afterEach
// ---------------------------------------------------------------------------

const ORIG_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const ORIG_APP_CLIENT_ID = process.env.COGNITO_APP_CLIENT_ID;

beforeEach(() => {
  vi.clearAllMocks();

  // Provide dummy env vars
  process.env.COGNITO_USER_POOL_ID = "us-east-1_TestPool123";
  process.env.COGNITO_APP_CLIENT_ID = "test-client-id-abc";

  // Wire the factory: every call to createMultiPoolVerifier returns a fresh
  // verifier object that delegates to verifyMock.
  createVerifierMock.mockReturnValue({ verify: verifyMock });

  // Reset the module-level singleton so each test starts clean
  resetVerifier();
});

afterEach(() => {
  // Restore env vars to whatever they were before
  if (ORIG_USER_POOL_ID === undefined) {
    delete process.env.COGNITO_USER_POOL_ID;
  } else {
    process.env.COGNITO_USER_POOL_ID = ORIG_USER_POOL_ID;
  }
  if (ORIG_APP_CLIENT_ID === undefined) {
    delete process.env.COGNITO_APP_CLIENT_ID;
  } else {
    process.env.COGNITO_APP_CLIENT_ID = ORIG_APP_CLIENT_ID;
  }
  resetVerifier();
});

// ===========================================================================
// extractBearerToken
// ===========================================================================

describe("extractBearerToken", () => {
  it("returns null for a null header", () => {
    expect(extractBearerToken(null)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractBearerToken("")).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(extractBearerToken("Token abc123")).toBeNull();
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
  });

  it("extracts the token after 'Bearer '", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("returns an empty string when nothing follows 'Bearer '", () => {
    // slice(7) of "Bearer " is ""
    expect(extractBearerToken("Bearer ")).toBe("");
  });

  it("preserves dots, dashes and underscores in the token", () => {
    const jwt = "eyJhbGc.eyJzdWIiO.SflKxwRJSM";
    expect(extractBearerToken(`Bearer ${jwt}`)).toBe(jwt);
  });
});

// ===========================================================================
// verifyCognitoJwt — success + claim narrowing
// ===========================================================================

describe("verifyCognitoJwt — success", () => {
  it("resolves with narrowed claims on a typical ID token payload", async () => {
    setupVerifySuccess();
    const result = await verifyCognitoJwt("valid.jwt.token");
    expect(result.sub).toBe("user-sub-uuid-1234");
    expect(result.email).toBe("user@example.com");
  });

  it("passes the token string directly to verify", async () => {
    setupVerifySuccess();
    await verifyCognitoJwt("my.token.value");
    expect(verifyMock).toHaveBeenCalledWith("my.token.value");
  });
});

// ===========================================================================
// verifyCognitoJwt — claim narrowing contract
// ===========================================================================

describe("verifyCognitoJwt — claim narrowing", () => {
  describe("username resolution", () => {
    it("prefers cognito:username over username when both are present", async () => {
      setupVerifySuccess(
        makeClaims({
          "cognito:username": "cognito-preferred",
          username: "regular-username",
        }),
      );
      const result = await verifyCognitoJwt("token");
      expect(result.username).toBe("cognito-preferred");
    });

    it("falls back to username when cognito:username is absent", async () => {
      const claims = makeClaims();
      delete claims["cognito:username"];
      (claims as any).username = "fallback-username";
      setupVerifySuccess(claims);
      const result = await verifyCognitoJwt("token");
      expect(result.username).toBe("fallback-username");
    });

    it("resolves to empty string when neither cognito:username nor username is present", async () => {
      const claims = makeClaims();
      delete claims["cognito:username"];
      setupVerifySuccess(claims);
      const result = await verifyCognitoJwt("token");
      expect(result.username).toBe("");
    });
  });

  describe("sub coercion", () => {
    it("coerces a missing sub to empty string instead of throwing", async () => {
      const claims = makeClaims();
      delete claims.sub;
      setupVerifySuccess(claims);
      const result = await verifyCognitoJwt("token");
      expect(result.sub).toBe("");
    });

    it("keeps a string sub as-is", async () => {
      setupVerifySuccess(makeClaims({ sub: "abc-def-ghi" }));
      const result = await verifyCognitoJwt("token");
      expect(result.sub).toBe("abc-def-ghi");
    });
  });

  describe("non-string claim coercion", () => {
    it("omits email when its value is not a string (number)", async () => {
      setupVerifySuccess(makeClaims({ email: 12345 }));
      const result = await verifyCognitoJwt("token");
      expect("email" in result).toBe(false);
    });

    it("omits email when its value is an object", async () => {
      setupVerifySuccess(makeClaims({ email: { nested: "bad" } }));
      const result = await verifyCognitoJwt("token");
      expect("email" in result).toBe(false);
    });

    it("omits email when its value is null", async () => {
      setupVerifySuccess(makeClaims({ email: null }));
      const result = await verifyCognitoJwt("token");
      expect("email" in result).toBe(false);
    });

    it("omits email when its value is boolean", async () => {
      setupVerifySuccess(makeClaims({ email: true }));
      const result = await verifyCognitoJwt("token");
      expect("email" in result).toBe(false);
    });

    it("coerces a numeric sub to empty string (non-string sub → '')", async () => {
      setupVerifySuccess(makeClaims({ sub: 99999 }));
      const result = await verifyCognitoJwt("token");
      expect(result.sub).toBe("");
    });
  });

  describe("custom:* claim pass-through", () => {
    it("passes through all custom:* string claims", async () => {
      const customClaims = {
        "custom:userId": "user-cuid-001",
        "custom:globalRole": "MEMBER",
        "custom:activeTenantId": "tenant-cuid-001",
        "custom:tenantSlug": "acme-corp",
        "custom:tenantRole": "ADMIN",
        "custom:handle": "@tester",
        "custom:dataRegion": "eu-central-1",
        "custom:role": "LEGACY_ROLE",
      };
      setupVerifySuccess(makeClaims(customClaims));
      const result = await verifyCognitoJwt("token");
      expect(result["custom:userId"]).toBe("user-cuid-001");
      expect(result["custom:globalRole"]).toBe("MEMBER");
      expect(result["custom:activeTenantId"]).toBe("tenant-cuid-001");
      expect(result["custom:tenantSlug"]).toBe("acme-corp");
      expect(result["custom:tenantRole"]).toBe("ADMIN");
      expect(result["custom:handle"]).toBe("@tester");
      expect(result["custom:dataRegion"]).toBe("eu-central-1");
      expect(result["custom:role"]).toBe("LEGACY_ROLE");
    });

    it("omits a custom:* claim when its value is not a string", async () => {
      setupVerifySuccess(makeClaims({ "custom:userId": 42 }));
      const result = await verifyCognitoJwt("token");
      expect("custom:userId" in result).toBe(false);
    });
  });

  describe("unknown claim filtering", () => {
    it("drops unknown/extra claims from the token", async () => {
      setupVerifySuccess(
        makeClaims({
          aud: "some-client-id",
          iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test",
          iat: 1716000000,
          exp: 1716003600,
          token_use: "id",
          someUnknownField: "should-be-dropped",
        }),
      );
      const result = await verifyCognitoJwt("token");
      // These known-JWT fields must not appear on the narrowed type
      expect((result as any).aud).toBeUndefined();
      expect((result as any).iss).toBeUndefined();
      expect((result as any).iat).toBeUndefined();
      expect((result as any).exp).toBeUndefined();
      expect((result as any).token_use).toBeUndefined();
      expect((result as any).someUnknownField).toBeUndefined();
    });
  });
});

// ===========================================================================
// verifyCognitoJwt — retry-once on MultiPoolVerifierError (S1.5)
// ===========================================================================

describe("verifyCognitoJwt — retry-once (S1.5)", () => {
  it("resolves when first verify throws MultiPoolVerifierError and second succeeds", async () => {
    verifyMock
      .mockRejectedValueOnce(new MultiPoolVerifierError("key not found"))
      .mockResolvedValueOnce({ claims: makeClaims() });

    const result = await verifyCognitoJwt("token");
    expect(result.sub).toBe("user-sub-uuid-1234");
  });

  it("recreates the verifier (calls createVerifierMock again) on retry", async () => {
    verifyMock
      .mockRejectedValueOnce(new MultiPoolVerifierError("jwks refresh"))
      .mockResolvedValueOnce({ claims: makeClaims() });

    await verifyCognitoJwt("token");

    // Factory must have been called twice: initial creation + recreation after error
    expect(createVerifierMock).toHaveBeenCalledTimes(2);
  });

  it("rejects when verify throws MultiPoolVerifierError on BOTH attempts", async () => {
    verifyMock
      .mockRejectedValueOnce(new MultiPoolVerifierError("first failure"))
      .mockRejectedValueOnce(new MultiPoolVerifierError("second failure"));

    await expect(verifyCognitoJwt("token")).rejects.toThrow("second failure");
  });
});

// ===========================================================================
// verifyCognitoJwt — NO retry on generic errors
// ===========================================================================

describe("verifyCognitoJwt — no retry on generic errors", () => {
  it("rethrows a plain Error without retrying", async () => {
    const expiredError = new Error("Token expired");
    verifyMock.mockRejectedValue(expiredError);

    await expect(verifyCognitoJwt("token")).rejects.toThrow("Token expired");
    // verify was called exactly once — no retry
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  it("does not call createVerifierMock a second time on generic error", async () => {
    verifyMock.mockRejectedValue(new Error("bad signature"));

    await expect(verifyCognitoJwt("token")).rejects.toThrow();
    expect(createVerifierMock).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// verifyCognitoJwt — lazy singleton and caching
// ===========================================================================

describe("verifyCognitoJwt — lazy singleton caching", () => {
  it("creates the verifier only once across multiple successful calls", async () => {
    setupVerifySuccess();

    await verifyCognitoJwt("token-1");
    await verifyCognitoJwt("token-2");
    await verifyCognitoJwt("token-3");

    expect(createVerifierMock).toHaveBeenCalledTimes(1);
  });

  it("recreates the verifier after resetVerifier()", async () => {
    setupVerifySuccess();

    await verifyCognitoJwt("token-a");
    expect(createVerifierMock).toHaveBeenCalledTimes(1);

    resetVerifier();

    await verifyCognitoJwt("token-b");
    expect(createVerifierMock).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// verifyCognitoJwt — 24-hour JWKS refresh
// ===========================================================================

describe("verifyCognitoJwt — 24-hour verifier refresh", () => {
  it("recreates the verifier when it is older than 24 hours", async () => {
    const base = 1_700_000_000_000; // arbitrary base timestamp (ms)
    const twentyFiveHoursMs = 25 * 60 * 60 * 1000;

    const dateSpy = vi.spyOn(Date, "now");
    dateSpy.mockReturnValueOnce(base); // first call — initial creation

    setupVerifySuccess();
    await verifyCognitoJwt("token-fresh");
    expect(createVerifierMock).toHaveBeenCalledTimes(1);

    // Advance time beyond 24 h for the next verifyCognitoJwt call
    dateSpy.mockReturnValue(base + twentyFiveHoursMs);

    await verifyCognitoJwt("token-stale");
    expect(createVerifierMock).toHaveBeenCalledTimes(2);

    dateSpy.mockRestore();
  });

  it("does NOT recreate the verifier when it is still within 24 hours", async () => {
    const base = 1_700_000_000_000;
    const twentyThreeHoursMs = 23 * 60 * 60 * 1000;

    const dateSpy = vi.spyOn(Date, "now");
    dateSpy.mockReturnValueOnce(base);

    setupVerifySuccess();
    await verifyCognitoJwt("token-fresh");
    expect(createVerifierMock).toHaveBeenCalledTimes(1);

    dateSpy.mockReturnValue(base + twentyThreeHoursMs);

    await verifyCognitoJwt("token-still-valid");
    expect(createVerifierMock).toHaveBeenCalledTimes(1);

    dateSpy.mockRestore();
  });
});

// ===========================================================================
// verifyCognitoJwt — missing env vars
// ===========================================================================

describe("verifyCognitoJwt — missing env vars", () => {
  it("rejects with a descriptive error when COGNITO_USER_POOL_ID is unset", async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    resetVerifier();

    await expect(verifyCognitoJwt("some.token")).rejects.toThrow(
      /COGNITO_USER_POOL_ID.*COGNITO_APP_CLIENT_ID|must be set/i,
    );

    // Restore for afterEach
    process.env.COGNITO_USER_POOL_ID = "us-east-1_TestPool123";
  });

  it("rejects with a descriptive error when COGNITO_APP_CLIENT_ID is unset", async () => {
    delete process.env.COGNITO_APP_CLIENT_ID;
    resetVerifier();

    await expect(verifyCognitoJwt("some.token")).rejects.toThrow(
      /COGNITO_USER_POOL_ID.*COGNITO_APP_CLIENT_ID|must be set/i,
    );

    // Restore for afterEach
    process.env.COGNITO_APP_CLIENT_ID = "test-client-id-abc";
  });

  it("rejects when both env vars are unset", async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_APP_CLIENT_ID;
    resetVerifier();

    await expect(verifyCognitoJwt("some.token")).rejects.toThrow(
      /must be set/i,
    );

    process.env.COGNITO_USER_POOL_ID = "us-east-1_TestPool123";
    process.env.COGNITO_APP_CLIENT_ID = "test-client-id-abc";
  });

  it("does not call createMultiPoolVerifier when env vars are missing", async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_APP_CLIENT_ID;
    resetVerifier();

    await expect(verifyCognitoJwt("some.token")).rejects.toThrow();
    expect(createVerifierMock).not.toHaveBeenCalled();

    process.env.COGNITO_USER_POOL_ID = "us-east-1_TestPool123";
    process.env.COGNITO_APP_CLIENT_ID = "test-client-id-abc";
  });
});

// ===========================================================================
// verifyCognitoJwt — pool config passed to createMultiPoolVerifier
// ===========================================================================

describe("verifyCognitoJwt — verifier pool config", () => {
  it("passes poolKey, userPoolId, clientId, tokenUse:id to the factory", async () => {
    setupVerifySuccess();
    await verifyCognitoJwt("token");

    expect(createVerifierMock).toHaveBeenCalledWith([
      expect.objectContaining({
        poolKey: "default",
        userPoolId: "us-east-1_TestPool123",
        clientId: "test-client-id-abc",
        tokenUse: "id",
      }),
    ]);
  });
});
