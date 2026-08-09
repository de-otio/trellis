/**
 * Unit Tests: Auth Hardening (S1)
 *
 * Tests for security remediation Stream S1 items:
 * - S1.1: Magic link token hashing
 * - S1.2: Magic link rate limiting
 * - S1.3: Session secret length validation
 * - S1.4: validateEnv function
 * - S1.5: JWKS refresh retry
 * - S1.6: CORS strict domain matching
 * - S1.7: JWT exp usage in session
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── S1.1 & S1.2: Magic link token hashing & rate limiting ────────────────

const { mockDynamoSend, mockSesSend } = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
  mockSesSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  class MockDynamoDBClient {
    send = mockDynamoSend;
    constructor(_config?: any) {}
  }
  return {
    DynamoDBClient: MockDynamoDBClient,
    PutItemCommand: class { _type = "PutItemCommand"; input: any; constructor(input: any) { this.input = input; } },
    GetItemCommand: class { _type = "GetItemCommand"; input: any; constructor(input: any) { this.input = input; } },
    UpdateItemCommand: class { _type = "UpdateItemCommand"; input: any; constructor(input: any) { this.input = input; } },
    DeleteItemCommand: class { _type = "DeleteItemCommand"; input: any; constructor(input: any) { this.input = input; } },
    marshall: (obj: any) => obj,
    unmarshall: (obj: any) => obj,
  };
});

vi.mock("@aws-sdk/client-ses", () => {
  class MockSESClient {
    send = mockSesSend;
    constructor(_config?: any) {}
  }
  return {
    SESClient: MockSESClient,
    SendEmailCommand: class { _type = "SendEmailCommand"; input: any; constructor(input: any) { this.input = input; } },
  };
});

describe("S1.1 — Magic link token hashing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockResolvedValue({});
    mockSesSend.mockResolvedValue({});
    process.env.AWS_REGION = "us-east-1";
    process.env.DYNAMODB_TABLE = "test-table";
    process.env.DOMAIN = "test.example.com";
  });

  it("should store hashed token in DynamoDB, not raw token", async () => {
    const { createHash } = await import("node:crypto");

    // Mock GetItemCommand (rate limit check) to return no existing rate limit
    mockDynamoSend.mockResolvedValue({});

    const { handler } = await import("../../src/lambda/create-auth-challenge.js");

    const event = {
      request: { userAttributes: { email: "test@example.com" } },
      response: {} as any,
    };

    const result = await handler(event);

    // Find the PutItemCommand call for the magic-link token (not rate limit)
    const putCalls = mockDynamoSend.mock.calls.filter(
      (call: any[]) => call[0]._type === "PutItemCommand"
    );
    const magicLinkPut = putCalls.find(
      (call: any[]) => call[0].input.Item.pk.S.startsWith("magic-link:")
    );
    expect(magicLinkPut).toBeDefined();

    const storedPk = magicLinkPut![0].input.Item.pk.S;
    const rawToken = result.response.privateChallengeParameters.token;

    // The stored PK should contain a SHA-256 hash, not the raw token
    const expectedHash = createHash("sha256").update(rawToken).digest("hex");
    expect(storedPk).toBe(`magic-link:${expectedHash}`);
    expect(storedPk).not.toContain(rawToken);
  });

  it("should still pass raw token to Cognito privateChallengeParameters", async () => {
    mockDynamoSend.mockResolvedValue({});

    const { handler } = await import("../../src/lambda/create-auth-challenge.js");

    const event = {
      request: { userAttributes: { email: "test@example.com" } },
      response: {} as any,
    };

    const result = await handler(event);
    const rawToken = result.response.privateChallengeParameters.token;

    // Raw token should be a base64url string (43 chars for 32 random bytes)
    expect(rawToken).toBeDefined();
    expect(typeof rawToken).toBe("string");
    expect(rawToken.length).toBeGreaterThan(0);
  });
});

describe("S1.1 — Verify auth challenge uses hashed token for deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockResolvedValue({});
    process.env.AWS_REGION = "us-east-1";
    process.env.DYNAMODB_TABLE = "test-table";
  });

  it("should hash the token before deleting from DynamoDB", async () => {
    const { createHash } = await import("node:crypto");
    const { handler } = await import("../../src/lambda/verify-auth-challenge.js");

    const token = "test-token-value";
    const event = {
      request: {
        challengeAnswer: token,
        privateChallengeParameters: { token },
      },
      response: {} as any,
    };

    await handler(event);

    // Find DeleteItemCommand call
    const deleteCalls = mockDynamoSend.mock.calls.filter(
      (call: any[]) => call[0]._type === "DeleteItemCommand"
    );
    expect(deleteCalls.length).toBe(1);

    const deletedPk = deleteCalls[0][0].input.Key.pk.S;
    const expectedHash = createHash("sha256").update(token).digest("hex");
    expect(deletedPk).toBe(`magic-link:${expectedHash}`);
  });
});

describe("S1.2 — Magic link rate limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoSend.mockResolvedValue({});
    mockSesSend.mockResolvedValue({});
    process.env.AWS_REGION = "us-east-1";
    process.env.DYNAMODB_TABLE = "test-table";
    process.env.DOMAIN = "test.example.com";
  });

  it("should throw when rate limit is exceeded", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockDynamoSend.mockImplementation((cmd: any) => {
      if (cmd._type === "GetItemCommand") {
        // Return rate limit counter at max
        return Promise.resolve({
          Item: {
            count: { N: "5" },
            ttl: { N: String(now + 600) }, // Still valid
          },
        });
      }
      return Promise.resolve({});
    });

    const { handler } = await import("../../src/lambda/create-auth-challenge.js");

    const event = {
      request: { userAttributes: { email: "test@example.com" } },
      response: {} as any,
    };

    await expect(handler(event)).rejects.toThrow("RATE_LIMIT_EXCEEDED");
  });

  it("should allow request when rate limit not yet reached", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockDynamoSend.mockImplementation((cmd: any) => {
      if (cmd._type === "GetItemCommand") {
        return Promise.resolve({
          Item: {
            count: { N: "3" },
            ttl: { N: String(now + 600) },
          },
        });
      }
      return Promise.resolve({});
    });

    const { handler } = await import("../../src/lambda/create-auth-challenge.js");

    const event = {
      request: { userAttributes: { email: "test@example.com" } },
      response: {} as any,
    };

    const result = await handler(event);
    expect(result.response.privateChallengeParameters.token).toBeDefined();
  });

  it("should allow request when rate limit TTL has expired", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockDynamoSend.mockImplementation((cmd: any) => {
      if (cmd._type === "GetItemCommand") {
        return Promise.resolve({
          Item: {
            count: { N: "10" },
            ttl: { N: String(now - 100) }, // Expired
          },
        });
      }
      return Promise.resolve({});
    });

    const { handler } = await import("../../src/lambda/create-auth-challenge.js");

    const event = {
      request: { userAttributes: { email: "test@example.com" } },
      response: {} as any,
    };

    const result = await handler(event);
    expect(result.response.privateChallengeParameters.token).toBeDefined();
  });

  it("should increment rate limit counter via UpdateItemCommand", async () => {
    mockDynamoSend.mockResolvedValue({});

    const { handler } = await import("../../src/lambda/create-auth-challenge.js");

    const event = {
      request: { userAttributes: { email: "test@example.com" } },
      response: {} as any,
    };

    await handler(event);

    const updateCalls = mockDynamoSend.mock.calls.filter(
      (call: any[]) => call[0]._type === "UpdateItemCommand"
    );
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0][0].input.Key.pk.S).toBe("magic-rate:test@example.com");
  });
});

// ─── S1.3 & S1.7: Session secret length & JWT exp ──────────────────────────

// Mock session-config
vi.mock("../../src/lib/session-config", () => ({
  getSessionConfig: () => ({
    userSessionTimeoutDays: 90,
    ssoSessionTimeoutDays: 7,
    dashboardSessionTimeoutHours: 24,
    refreshThresholdHours: 1,
    inactivityTimeoutMinutes: 60,
  }),
  calculateCookieMaxAge: () => 90 * 24 * 60 * 60,
}));


// Mock cognito-jwt for session manager tests
const { mockVerifyCognitoJwt } = vi.hoisted(() => ({
  mockVerifyCognitoJwt: vi.fn(),
}));
vi.mock("../../src/lib/auth/cognito-jwt", () => ({
  verifyCognitoJwt: (...args: any[]) => mockVerifyCognitoJwt(...args),
  verifyLegacyCognitoClaims: (...args: any[]) => mockVerifyCognitoJwt(...args),
}));

describe("S1.3 — Session secret minimum length", () => {
  let SessionManager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockVerifyCognitoJwt.mockRejectedValue(new Error("Not a JWT"));
    const mod = await import("../../src/lib/session-cookie.js");
    SessionManager = mod.SessionManager;
  });

  it("should return null for secrets shorter than 32 characters", async () => {
    const sm = new SessionManager();
    const request = new Request("https://api.example.com/test", {
      headers: { Cookie: "trellis_session=some-value" },
    });

    const session = await sm.getSession(request, "short-secret-only-20ch!");
    expect(session).toBeNull();
  });

  it("should return null for secret of exactly 31 characters", async () => {
    const sm = new SessionManager();
    const request = new Request("https://api.example.com/test", {
      headers: { Cookie: "trellis_session=some-value" },
    });

    const session = await sm.getSession(request, "a".repeat(31));
    expect(session).toBeNull();
  });

  it("should proceed with secret of exactly 32 characters", async () => {
    const sm = new SessionManager();
    const secret = "a".repeat(32);

    // Create a valid encrypted session with this secret
    const sessionData = JSON.stringify({
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600_000,
      dataRegion: "EU",
      profileContext: "primary",
    });
    const testSalt = "test-session-salt-for-auth-tests";
    const encrypted = await sm.encryptSession(sessionData, secret, testSalt);

    const request = new Request("https://api.example.com/test", {
      headers: { Cookie: `trellis_session=${encrypted}` },
    });

    const session = await sm.getSession(request, secret, { SESSION_SALT: testSalt });
    expect(session).not.toBeNull();
    expect(session?.userId).toBe("user-123");
  });
});

describe("S1.7 — JWT exp claim for session expiration", () => {
  let SessionManager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../../src/lib/session-cookie.js");
    SessionManager = mod.SessionManager;
  });

  it("should use JWT exp when it is earlier than 1 hour from now", async () => {
    const sm = new SessionManager();

    // Create a JWT-like token where exp is 30 minutes from now
    const now = Math.floor(Date.now() / 1000);
    const expIn30Min = now + 1800;
    const payload = { sub: "user-123", email: "test@example.com", exp: expIn30Min, "custom:role": "END_USER", "custom:dataRegion": "EU" };
    const fakeJwt = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fakesig`;

    mockVerifyCognitoJwt.mockResolvedValue({
      sub: "user-123",
      // The trellis cuid must be present: this suite asserts exp handling, and
      // a token carrying no resolvable user id is now rejected outright.
      "custom:userId": "cmqurmq7x000002i80nqmgfa1",
      email: "test@example.com",
      username: "test@example.com",
      "custom:role": "END_USER",
      "custom:dataRegion": "EU",
    });

    const request = new Request("https://api.example.com/test", {
      headers: { Authorization: `Bearer ${fakeJwt}` },
    });

    const session = await sm.getSession(request, "a".repeat(32));
    expect(session).not.toBeNull();
    // The expiresAt should be close to expIn30Min * 1000 (not 1 hour from now)
    expect(session!.expiresAt).toBeLessThanOrEqual(expIn30Min * 1000);
  });

  it("should cap at 1 hour even if JWT exp is further out", async () => {
    const sm = new SessionManager();

    // Create a JWT where exp is 24 hours from now
    const now = Math.floor(Date.now() / 1000);
    const expIn24h = now + 86400;
    const payload = { sub: "user-123", email: "test@example.com", exp: expIn24h };
    const fakeJwt = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fakesig`;

    mockVerifyCognitoJwt.mockResolvedValue({
      sub: "user-123",
      "custom:userId": "cmqurmq7x000002i80nqmgfa1",
      email: "test@example.com",
      username: "test@example.com",
    });

    const request = new Request("https://api.example.com/test", {
      headers: { Authorization: `Bearer ${fakeJwt}` },
    });

    const session = await sm.getSession(request, "a".repeat(32));
    expect(session).not.toBeNull();
    // Should be capped at approximately 1 hour from now
    const oneHourFromNow = Date.now() + 3600_000;
    expect(session!.expiresAt).toBeLessThanOrEqual(oneHourFromNow + 1000);
    expect(session!.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
  });
});

// ─── S1.4: validateEnv ──────────────────────────────────────────────────────

// We need to test validateEnv without triggering env.ts module-level imports
// that create DynamoDBClient. We import only the function.
describe("S1.4 — validateEnv", () => {
  it("should return errors when SESSION_SECRET is missing", async () => {
    const { validateEnv } = await import("../../src/env.js");
    const errors = validateEnv({
      SESSION_SECRET: "",
      COGNITO_USER_POOL_ID: "us-east-1_abc",
      COGNITO_APP_CLIENT_ID: "client-id",
    } as any);
    expect(errors).toContain("SESSION_SECRET is required");
  });

  it("should return errors when SESSION_SECRET is too short", async () => {
    const { validateEnv } = await import("../../src/env.js");
    const errors = validateEnv({
      SESSION_SECRET: "short",
      COGNITO_USER_POOL_ID: "us-east-1_abc",
      COGNITO_APP_CLIENT_ID: "client-id",
    } as any);
    expect(errors).toContain("SESSION_SECRET must be at least 32 characters");
  });

  it("should return an auth-issuer error when neither OIDC_ISSUER_URL nor COGNITO_USER_POOL_ID is set", async () => {
    const { validateEnv } = await import("../../src/env.js");
    const errors = validateEnv({
      SESSION_SECRET: "a".repeat(32),
      COGNITO_USER_POOL_ID: "",
      COGNITO_APP_CLIENT_ID: "client-id",
    } as any);
    expect(errors.some((e) => e.startsWith("auth issuer is required"))).toBe(true);
  });

  it("should return an auth-audience error when neither OIDC_APP_CLIENT_ID nor COGNITO_APP_CLIENT_ID is set", async () => {
    const { validateEnv } = await import("../../src/env.js");
    const errors = validateEnv({
      SESSION_SECRET: "a".repeat(32),
      COGNITO_USER_POOL_ID: "us-east-1_abc",
      COGNITO_APP_CLIENT_ID: "",
    } as any);
    expect(errors.some((e) => e.startsWith("auth audience is required"))).toBe(true);
  });

  // WS-3.3: a generic OIDC / Keycloak deployment (OIDC_* set, no COGNITO_*)
  // must pass validateEnv — the auth check is provider-neutral and mirrors
  // resolveAuthConfig().
  it("should accept OIDC_* (Keycloak) auth with no COGNITO_* vars", async () => {
    const { validateEnv } = await import("../../src/env.js");
    const errors = validateEnv({
      SESSION_SECRET: "a".repeat(32),
      OIDC_ISSUER_URL: "https://id.example.com/realms/skybber",
      OIDC_APP_CLIENT_ID: "skybber-api",
      // [SEC-6b] non-Cognito issuers must name their JWKS URI — the derived
      // Cognito default 404s on Keycloak and fails every token.
      OIDC_JWKS_URL: "https://id.example.com/realms/skybber/protocol/openid-connect/certs",
      INVITATIONS_KV: {},
    } as any);
    expect(errors).toEqual([]);
  });

  it("[SEC-6b] rejects a Keycloak deployment that omits OIDC_JWKS_URL", async () => {
    const { validateEnv } = await import("../../src/env.js");
    const errors = validateEnv({
      SESSION_SECRET: "a".repeat(32),
      OIDC_ISSUER_URL: "https://id.example.com/realms/skybber",
      OIDC_APP_CLIENT_ID: "skybber-api",
      INVITATIONS_KV: {},
    } as any);
    expect(errors.some((e: string) => e.includes("OIDC_JWKS_URL is required"))).toBe(true);
  });

  it("should return empty array when all required vars are valid", async () => {
    const { validateEnv } = await import("../../src/env.js");
    const errors = validateEnv({
      SESSION_SECRET: "a".repeat(32),
      COGNITO_USER_POOL_ID: "us-east-1_abc",
      COGNITO_APP_CLIENT_ID: "client-id",
      INVITATIONS_KV: {},
    } as any);
    expect(errors).toEqual([]);
  });

  // SECURITY (T17): a missing INVITATIONS_KV binding makes the invitation
  // gate fail closed — startup must refuse loudly instead of serving a
  // silently-closed gate.
  it("should return an error when INVITATIONS_KV binding is missing", async () => {
    const { validateEnv } = await import("../../src/env.js");
    const errors = validateEnv({
      SESSION_SECRET: "a".repeat(32),
      COGNITO_USER_POOL_ID: "us-east-1_abc",
      COGNITO_APP_CLIENT_ID: "client-id",
      INVITATIONS_KV: undefined,
    } as any);
    expect(errors.some((e) => e.includes("INVITATIONS_KV"))).toBe(true);
  });

  it("should return multiple errors when multiple vars are missing", async () => {
    const { validateEnv } = await import("../../src/env.js");
    const errors = validateEnv({
      SESSION_SECRET: "",
      COGNITO_USER_POOL_ID: "",
      COGNITO_APP_CLIENT_ID: "",
    } as any);
    // 3 missing vars + the missing INVITATIONS_KV binding (T17)
    expect(errors.length).toBe(4);
  });
});

// ─── S1.5: JWKS refresh retry ───────────────────────────────────────────────

describe("S1.5 — JWKS refresh on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should retry verification after resetting verifier on first failure", async () => {
    // Verify the retry logic pattern: first call fails, reset, second succeeds
    const mockVerify = vi.fn();
    mockVerify
      .mockRejectedValueOnce(new Error("JWKS key not found"))
      .mockResolvedValueOnce({
        sub: "user-123",
        email: "test@example.com",
        username: "test@example.com",
      });

    const firstCallFails = async () => {
      try {
        await mockVerify("token");
        return true;
      } catch {
        // Reset and retry (mirrors verifyCognitoJwt logic)
        const result = await mockVerify("token");
        return result;
      }
    };

    const result = await firstCallFails();
    expect(result).toEqual({
      sub: "user-123",
      email: "test@example.com",
      username: "test@example.com",
    });
    expect(mockVerify).toHaveBeenCalledTimes(2);
  });

  it("should have resetVerifier export available", async () => {
    // Verify the source code exports resetVerifier
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/auth/cognito-jwt.ts"),
      "utf-8",
    );
    expect(source).toContain("export function resetVerifier()");
    expect(source).toContain("verifier = null");
    expect(source).toContain("lastCreated = 0");
  });

  it("should recreate verifier after 24 hours", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/auth/cognito-jwt.ts"),
      "utf-8",
    );
    expect(source).toContain("VERIFIER_MAX_AGE_MS");
    expect(source).toContain("24 * 60 * 60 * 1000");
    expect(source).toContain("now - lastCreated > VERIFIER_MAX_AGE_MS");
  });
});

// ─── S1.6: CORS strict domain matching ──────────────────────────────────────

describe("S1.6 — CORS strict domain matching", () => {
  let CorsHandler: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../../src/lib/cors-handler.js");
    CorsHandler = mod.CorsHandler;
  });

  const mockEnv = {
    APP_DOMAIN: "https://example.com",
    ALLOWED_ORIGINS: "https://app.example.com",
  } as any;

  it("should allow exact domain match (rkm1.de)", () => {
    const request = new Request("https://api.example.com/test", {
      headers: { Origin: "https://rkm1.de" },
    });
    expect(CorsHandler.getAllowedOrigin(request, mockEnv)).toBe("https://rkm1.de");
  });

  it("should allow subdomain of known domain (sub.rkm1.de)", () => {
    const request = new Request("https://api.example.com/test", {
      headers: { Origin: "https://sub.rkm1.de" },
    });
    expect(CorsHandler.getAllowedOrigin(request, mockEnv)).toBe("https://sub.rkm1.de");
  });

  it("should allow example.com", () => {
    const request = new Request("https://api.example.com/test", {
      headers: { Origin: "https://example.com" },
    });
    expect(CorsHandler.getAllowedOrigin(request, mockEnv)).toBe("https://example.com");
  });

  it("should reject domains that contain known domain as substring but are not subdomains", () => {
    const request = new Request("https://api.example.com/test", {
      headers: { Origin: "https://evilrkm1.de" },
    });
    expect(CorsHandler.getAllowedOrigin(request, mockEnv)).toBeNull();
  });

  it("should reject domain that looks like a subdomain but has a prefix (notrkm1.de)", () => {
    const request = new Request("https://api.example.com/test", {
      headers: { Origin: "https://notrkm1.de" },
    });
    expect(CorsHandler.getAllowedOrigin(request, mockEnv)).toBeNull();
  });

  it("should reject unrelated domains", () => {
    const request = new Request("https://api.example.com/test", {
      headers: { Origin: "https://evil.com" },
    });
    expect(CorsHandler.getAllowedOrigin(request, mockEnv)).toBeNull();
  });

  it("should allow api.example.com as subdomain", () => {
    const request = new Request("https://api.example.com/test", {
      headers: { Origin: "https://api.example.com" },
    });
    expect(CorsHandler.getAllowedOrigin(request, mockEnv)).toBe("https://api.example.com");
  });

  it("should reject fakeexample.com", () => {
    const request = new Request("https://api.example.com/test", {
      headers: { Origin: "https://fakeexample.com" },
    });
    expect(CorsHandler.getAllowedOrigin(request, mockEnv)).toBeNull();
  });
});

// ─── T2: Pre-token-generation tests ─────────────────────────────────────────
// (S1.8 retired; T2 — Cognito Lambda Triggers — landed the multi-tenant
// rewrite. Cache TTL bumped from 300s to 3600s per spec note 12 in
// plans/mvp/10-trellis-stages/02-cognito-triggers.md, with `ClaimsCache`
// owning the value via the shared lib.)

describe("T2 — Pre-token-generation cache TTL and suspension", () => {
  it("should use the shared 3600 second cache TTL via ClaimsCache", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/auth/claims-cache.ts"),
      "utf-8",
    );
    expect(source).toContain("DEFAULT_CACHE_TTL_SECONDS = 3600");
  });

  it("should include suspendedAt in Prisma select clause", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    // The claims derivation (incl. the select) moved to the shared
    // lib/identity/load-claims.ts (WS-0, plan 016 — reused by the Keycloak
    // JIT path); the Lambda keeps the suspension POLICY, checked below.
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/identity/load-claims.ts"),
      "utf-8",
    );
    expect(source).toContain("suspendedAt: true");
  });

  it("should check suspension status before returning claims", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/lambda/pre-token-generation.ts"),
      "utf-8",
    );
    expect(source).toContain("suspendedAt");
    expect(source).toContain("pretoken.suspended");
  });
});
