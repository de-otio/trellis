/**
 * Unit Tests: Extension tenant context — Part A (05a §3, §7.2)
 *
 * The `activeTenantId` chain, at the session layer:
 *   - surfaced ONLY from a verified Cognito JWT (getSession Strategy 1a),
 *     CUID-validated, empty-string normalized to undefined;
 *   - NEVER persisted in sealed material (encryptSession strip) — covers every
 *     re-seal site (CSRF refresh, MFA verify) by construction;
 *   - NEVER trusted from a decrypted cookie/localStorage payload
 *     (narrowSession / narrowSessionForAuthHeader strips — defense in depth).
 *
 * The wrapper-side minting + whitelist narrowing is tested in
 * extension-route-wrapper.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCookie } from "@de-otio/saas-foundation/session";
import { SessionManager, type Session } from "../../src/lib/session-cookie.js";

// Mock Cognito JWT verification (Bearer-token auth strategy 1a).
const { mockVerifyCognitoJwt } = vi.hoisted(() => ({
  mockVerifyCognitoJwt: vi.fn(),
}));
vi.mock("../../src/lib/auth/cognito-jwt", () => ({
  verifyCognitoJwt: mockVerifyCognitoJwt,
  verifyLegacyCognitoClaims: mockVerifyCognitoJwt,
}));

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

const USER_ID = "cmqurmq7x000002i80nqmgfr8"; // cuid
const VALID_TENANT = "cmtaxonaaa000000000000001"; // cuid-shaped

describe("extension tenant context — Part A (session layer)", () => {
  let sm: SessionManager;
  const secret = "test-secret-key-32-characters-long!!";
  const salt = "test-session-salt-for-unit-tests";
  const env: any = { SESSION_SALT: salt };

  const bearerReq = (token = "h.cA.s") =>
    new Request("https://example.com/api/ext/dog/x", {
      headers: { Authorization: `Bearer ${token}` },
    });

  beforeEach(() => {
    sm = new SessionManager();
    vi.clearAllMocks();
  });

  describe("getSession Strategy 1a — surfacing the verified claim", () => {
    it("surfaces a valid custom:activeTenantId from the verified JWT", async () => {
      mockVerifyCognitoJwt.mockResolvedValue({
        sub: "23643892-00c1-7057-551c-aed44aed1f13",
        "custom:userId": USER_ID,
        email: "user@example.com",
        username: "user@example.com",
        "custom:activeTenantId": VALID_TENANT,
      });

      const session = await sm.getSession(bearerReq(), secret, env);

      expect(session?.activeTenantId).toBe(VALID_TENANT);
    });

    it("drops a malformed (non-cuid) activeTenantId claim", async () => {
      mockVerifyCognitoJwt.mockResolvedValue({
        "custom:userId": USER_ID,
        email: "user@example.com",
        username: "user@example.com",
        "custom:activeTenantId": "not-a-cuid",
      });

      const session = await sm.getSession(bearerReq(), secret, env);

      expect(session?.userId).toBe(USER_ID);
      expect(session?.activeTenantId).toBeUndefined();
    });

    it("normalizes the empty-string claim (no active membership) to undefined", async () => {
      // pre-token-generation writes "" when the user has no active membership;
      // it must become undefined so the wrapper's personal-tenant fallback runs.
      mockVerifyCognitoJwt.mockResolvedValue({
        "custom:userId": USER_ID,
        email: "user@example.com",
        username: "user@example.com",
        "custom:activeTenantId": "",
      });

      const session = await sm.getSession(bearerReq(), secret, env);

      expect(session?.activeTenantId).toBeUndefined();
    });

    it("leaves activeTenantId undefined when the claim is absent", async () => {
      mockVerifyCognitoJwt.mockResolvedValue({
        "custom:userId": USER_ID,
        email: "user@example.com",
        username: "user@example.com",
      });

      const session = await sm.getSession(bearerReq(), secret, env);

      expect(session?.activeTenantId).toBeUndefined();
    });
  });

  describe("seal strip — activeTenantId never reaches sealed material", () => {
    it("encryptSession strips activeTenantId from the sealed payload", async () => {
      const withTenant = {
        userId: USER_ID,
        email: "user@example.com",
        expiresAt: Date.now() + 3_600_000,
        profileContext: "primary" as const,
        activeTenantId: VALID_TENANT,
      };

      const sealed = await sm.encryptSession(JSON.stringify(withTenant), secret, salt);
      const plaintext = await sm.decryptSession(sealed, secret, salt);
      const parsed = JSON.parse(plaintext!);

      expect(parsed.userId).toBe(USER_ID);
      expect(parsed.activeTenantId).toBeUndefined();
    });

    it("re-sealing a JWT-derived session (CSRF/MFA path) does not persist the tenant", async () => {
      // Mirrors routes/health.ts + routes/mfa.ts: a session that carries a
      // verified activeTenantId is fed back into sealed material. The strip
      // ensures the ≤1h-verified tenant can never ride a 90-day cookie.
      mockVerifyCognitoJwt.mockResolvedValue({
        "custom:userId": USER_ID,
        email: "user@example.com",
        username: "user@example.com",
        "custom:activeTenantId": VALID_TENANT,
      });
      const jwtSession = await sm.getSession(bearerReq(), secret, env);
      expect(jwtSession?.activeTenantId).toBe(VALID_TENANT); // present in-memory

      const resealed = await sm.encryptSession(
        JSON.stringify(jwtSession),
        secret,
        salt,
      );
      const roundTripped = await sm.decryptSession(resealed, secret, salt);

      expect(JSON.parse(roundTripped!).activeTenantId).toBeUndefined();
    });
  });

  describe("unseal strip — a sealed payload can never supply a tenant", () => {
    // Inject a "legacy" sealed payload that CONTAINS activeTenantId, bypassing
    // encryptSession's seal-time strip, via the foundation cookie directly.
    // Phase 8: the inactivity check now fails CLOSED when a sealed payload
    // carries neither `lastActivityAt` nor the seal-time `sessionEpoch`. These
    // fixtures deliberately bypass `encryptSession` (which stamps the epoch),
    // so they supply `lastActivityAt` themselves — otherwise getSession would
    // reject them for inactivity before the tenant-strip assertion is reached.
    async function sealRaw(payload: object): Promise<string> {
      return new SessionCookie({ primarySecret: secret, salt }).seal(
        JSON.stringify({ lastActivityAt: Date.now(), ...payload }),
      );
    }

    it("narrowSession (cookie path) strips activeTenantId", async () => {
      const token = await sealRaw({
        userId: USER_ID,
        email: "user@example.com",
        expiresAt: Date.now() + 3_600_000,
        profileContext: "primary",
        activeTenantId: VALID_TENANT,
      });
      const request = new Request("https://example.com/api/ext/dog/x", {
        headers: { Cookie: `trellis_session=${token}` },
      });

      const session = await sm.getSession(request, secret, env);

      expect(session?.userId).toBe(USER_ID);
      expect(session?.activeTenantId).toBeUndefined();
    });

    it("narrowSessionForAuthHeader (localStorage token path) strips activeTenantId", async () => {
      // A non-JWT (encrypted) token in the Authorization header — Strategy 1b.
      const token = await sealRaw({
        userId: USER_ID,
        email: "user@example.com",
        expiresAt: Date.now() + 3_600_000,
        profileContext: "primary",
        activeTenantId: VALID_TENANT,
      });
      const request = new Request("https://example.com/api/ext/dog/x", {
        headers: { Authorization: `Bearer ${token}` },
      });

      const session = await sm.getSession(request, secret, env);

      expect(session?.userId).toBe(USER_ID);
      expect(session?.activeTenantId).toBeUndefined();
    });
  });
});
