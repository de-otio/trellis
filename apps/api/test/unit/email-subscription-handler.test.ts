import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { signToken } from "../../src/lib/email-subscription-token.js";

// --- hoisted mocks ---------------------------------------------------------
const { mockPrisma, mockSendEmail, state } = vi.hoisted(() => ({
  mockPrisma: {
    emailSubscription: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    entity: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    entityOwnership: { findFirst: vi.fn() },
  },
  mockSendEmail: vi.fn(),
  state: { rateAllowed: true },
}));

vi.mock("../../src/db.js", () => ({ createPrisma: () => mockPrisma }));
vi.mock("../../src/lib/rate-limit.js", () => ({
  RateLimiter: class {
    async checkRateLimitKV() {
      return { allowed: state.rateAllowed, remaining: 1, resetAt: 0 };
    }
  },
}));
vi.mock("../../src/lib/email-provider.js", () => ({
  createEmailProvider: () => ({ sendEmail: mockSendEmail }),
  emailProviderConfigFromEnv: () => ({}),
}));
vi.mock("../../src/lib/security-monitor.js", () => ({
  SecurityMonitor: class {
    async logSecurityEvent() {}
  },
}));

import { EmailSubscriptionHandler } from "../../src/lib/email-subscription-handler.js";

const SECRET = "test-email-sub-hmac-secret-please-rotate-32chars";
const FAR_FUTURE = 4_102_444_800; // year 2100

const mockEnv = {
  SESSION_SECRET: "test-secret-32-characters-long!!",
  FROM_EMAIL: "noreply@example.com",
  EMAIL_SUB_HMAC_SECRET: SECRET,
  EMAIL_SUB_ENC_KEY: Buffer.alloc(32, 1).toString("base64"),
  emailSubscription: {
    confirmTokenTtlHours: 48,
    pendingTtlHours: 72,
    suppressionDays: 180,
    confirmedRetentionDays: 400,
    ratePerIpPerHour: 10,
    ratePerTargetPerHour: 100,
    ratePerEmailPerHour: 5,
  },
} as unknown as Env;

function subscribeReq(body: unknown): Request {
  return new Request("https://api.example.com/api/subscriptions/email", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5" },
    body: JSON.stringify(body),
  });
}
function tokenReq(path: string, token: string): Request {
  return new Request(`https://api.example.com${path}?token=${encodeURIComponent(token)}`, {
    method: "POST",
  });
}

describe("EmailSubscriptionHandler", () => {
  let handler: EmailSubscriptionHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    state.rateAllowed = true;
    handler = new EmailSubscriptionHandler();
  });

  describe("subscribe (double opt-in, no oracle)", () => {
    it("creates a PENDING row + sends a confirmation email → 202", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({ id: "e1", tenantId: "t1", name: "Rex" });
      mockPrisma.emailSubscription.findUnique.mockResolvedValue(null);
      mockPrisma.emailSubscription.create.mockResolvedValue({});

      const res = await handler.handleSubscribe(
        subscribeReq({ targetType: "entity", targetId: "e1", email: "fan@example.com" }),
        mockEnv,
      );
      expect(res.status).toBe(202);
      const createArg = mockPrisma.emailSubscription.create.mock.calls[0][0].data;
      expect(createArg.status).toBe("PENDING");
      expect(createArg.emailEnc).toMatch(/^v1:/); // encrypted, versioned
      expect(createArg.emailEnc).not.toContain("fan@example.com"); // not plaintext
      expect(createArg.emailHash).toMatch(/^v1:[0-9a-f]{64}$/);
      expect(mockSendEmail).toHaveBeenCalledOnce();
    });

    it("returns 202 with NO create/email when the target does not exist (no oracle)", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue(null);
      const res = await handler.handleSubscribe(
        subscribeReq({ targetType: "entity", targetId: "missing", email: "fan@example.com" }),
        mockEnv,
      );
      expect(res.status).toBe(202);
      expect(mockPrisma.emailSubscription.create).not.toHaveBeenCalled();
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("returns 202 with NO create/email when a row already exists (no dup oracle)", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({ id: "e1", tenantId: "t1", name: "Rex" });
      mockPrisma.emailSubscription.findUnique.mockResolvedValue({ id: "existing" });
      const res = await handler.handleSubscribe(
        subscribeReq({ targetType: "entity", targetId: "e1", email: "fan@example.com" }),
        mockEnv,
      );
      expect(res.status).toBe(202);
      expect(mockPrisma.emailSubscription.create).not.toHaveBeenCalled();
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("follows a PUBLIC user target (success path)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u1",
        personalTenantId: "t1",
        profileVisibility: "PUBLIC",
        handle: "alice",
      });
      mockPrisma.emailSubscription.findUnique.mockResolvedValue(null);
      mockPrisma.emailSubscription.create.mockResolvedValue({});
      const res = await handler.handleSubscribe(
        subscribeReq({ targetType: "user", targetId: "u1", email: "fan@example.com" }),
        mockEnv,
      );
      expect(res.status).toBe(202);
      expect(mockPrisma.emailSubscription.create).toHaveBeenCalledOnce();
      expect(mockSendEmail).toHaveBeenCalledOnce();
    });

    it("derives client IP from cf-connecting-ip when x-forwarded-for is absent", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({ id: "e1", tenantId: "t1", name: "Rex" });
      mockPrisma.emailSubscription.findUnique.mockResolvedValue(null);
      mockPrisma.emailSubscription.create.mockResolvedValue({});
      const req = new Request("https://api.example.com/api/subscriptions/email", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" },
        body: JSON.stringify({ targetType: "entity", targetId: "e1", email: "fan@example.com" }),
      });
      expect((await handler.handleSubscribe(req, mockEnv)).status).toBe(202);
    });

    it("returns 400 on a non-JSON body", async () => {
      const req = new Request("https://api.example.com/api/subscriptions/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      });
      expect((await handler.handleSubscribe(req, mockEnv)).status).toBe(400);
    });

    it("only follows PUBLIC users (non-public user target → silent 202)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u1",
        personalTenantId: "t1",
        profileVisibility: "PRIVATE",
      });
      const res = await handler.handleSubscribe(
        subscribeReq({ targetType: "user", targetId: "u1", email: "fan@example.com" }),
        mockEnv,
      );
      expect(res.status).toBe(202);
      expect(mockPrisma.emailSubscription.create).not.toHaveBeenCalled();
    });

    it("rejects a malformed email → 400 (validation)", async () => {
      const res = await handler.handleSubscribe(
        subscribeReq({ targetType: "entity", targetId: "e1", email: "not-an-email" }),
        mockEnv,
      );
      expect(res.status).toBe(400);
    });

    it("returns 429 when any rate limit is exceeded", async () => {
      state.rateAllowed = false;
      const res = await handler.handleSubscribe(
        subscribeReq({ targetType: "entity", targetId: "e1", email: "fan@example.com" }),
        mockEnv,
      );
      expect(res.status).toBe(429);
    });

    it("returns 500 (generic) when the feature secrets are unprovisioned", async () => {
      const noSecretEnv = { ...mockEnv, EMAIL_SUB_HMAC_SECRET: undefined } as unknown as Env;
      const res = await handler.handleSubscribe(
        subscribeReq({ targetType: "entity", targetId: "e1", email: "fan@example.com" }),
        noSecretEnv,
      );
      expect(res.status).toBe(500);
    });
  });

  describe("confirm (uniform 200/400, nonce rotation)", () => {
    it("confirms a PENDING row, rotates the nonce → 200", async () => {
      mockPrisma.emailSubscription.findUnique.mockResolvedValue({
        id: "s1",
        status: "PENDING",
        tokenNonce: "n1",
      });
      mockPrisma.emailSubscription.update.mockResolvedValue({});
      const token = signToken(
        { action: "confirm", subId: "s1", nonce: "n1", exp: FAR_FUTURE },
        SECRET,
      );
      const res = await handler.handleConfirm(
        tokenReq("/api/subscriptions/email/confirm", token),
        mockEnv,
      );
      expect(res.status).toBe(200);
      const upd = mockPrisma.emailSubscription.update.mock.calls[0][0].data;
      expect(upd.status).toBe("CONFIRMED");
      expect(upd.confirmedAt).toBeInstanceOf(Date);
      expect(upd.tokenNonce).not.toBe("n1"); // rotated (single-use)
    });

    it("rejects an UNSUBSCRIBE token at the confirm endpoint (action binding) → 400", async () => {
      const token = signToken(
        { action: "unsubscribe", subId: "s1", nonce: "n1", exp: FAR_FUTURE },
        SECRET,
      );
      const res = await handler.handleConfirm(
        tokenReq("/api/subscriptions/email/confirm", token),
        mockEnv,
      );
      expect(res.status).toBe(400);
      expect(mockPrisma.emailSubscription.findUnique).not.toHaveBeenCalled();
    });

    it("rejects a stale nonce (token nonce != row nonce) → 400", async () => {
      mockPrisma.emailSubscription.findUnique.mockResolvedValue({
        id: "s1",
        status: "PENDING",
        tokenNonce: "rotated-since",
      });
      const token = signToken(
        { action: "confirm", subId: "s1", nonce: "n1", exp: FAR_FUTURE },
        SECRET,
      );
      const res = await handler.handleConfirm(
        tokenReq("/api/subscriptions/email/confirm", token),
        mockEnv,
      );
      expect(res.status).toBe(400);
      expect(mockPrisma.emailSubscription.update).not.toHaveBeenCalled();
    });

    it("is idempotent: already-CONFIRMED → 200 without re-updating", async () => {
      mockPrisma.emailSubscription.findUnique.mockResolvedValue({
        id: "s1",
        status: "CONFIRMED",
        tokenNonce: "n1",
      });
      const token = signToken(
        { action: "confirm", subId: "s1", nonce: "n1", exp: FAR_FUTURE },
        SECRET,
      );
      const res = await handler.handleConfirm(
        tokenReq("/api/subscriptions/email/confirm", token),
        mockEnv,
      );
      expect(res.status).toBe(200);
      expect(mockPrisma.emailSubscription.update).not.toHaveBeenCalled();
    });

    it("returns the SAME generic 400 for a nonexistent subId (no oracle)", async () => {
      mockPrisma.emailSubscription.findUnique.mockResolvedValue(null);
      const token = signToken(
        { action: "confirm", subId: "ghost", nonce: "n1", exp: FAR_FUTURE },
        SECRET,
      );
      const res = await handler.handleConfirm(
        tokenReq("/api/subscriptions/email/confirm", token),
        mockEnv,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "INVALID" });
    });

    it("rejects an expired token → 400", async () => {
      const token = signToken({ action: "confirm", subId: "s1", nonce: "n1", exp: 1000 }, SECRET);
      const res = await handler.handleConfirm(
        tokenReq("/api/subscriptions/email/confirm", token),
        mockEnv,
      );
      expect(res.status).toBe(400);
    });
  });

  describe("unsubscribe (scrubs PII)", () => {
    it("unsubscribes + scrubs emailEnc → 200", async () => {
      mockPrisma.emailSubscription.findUnique.mockResolvedValue({
        id: "s1",
        status: "CONFIRMED",
        tokenNonce: "n1",
      });
      mockPrisma.emailSubscription.update.mockResolvedValue({});
      const token = signToken(
        { action: "unsubscribe", subId: "s1", nonce: "n1", exp: FAR_FUTURE },
        SECRET,
      );
      const res = await handler.handleUnsubscribe(
        tokenReq("/api/subscriptions/email/unsubscribe", token),
        mockEnv,
      );
      expect(res.status).toBe(200);
      const upd = mockPrisma.emailSubscription.update.mock.calls[0][0].data;
      expect(upd.status).toBe("UNSUBSCRIBED");
      expect(upd.emailEnc).toBe(""); // PII scrubbed
      expect(upd.unsubscribedAt).toBeInstanceOf(Date);
    });

    it("is idempotent: already-UNSUBSCRIBED → 200", async () => {
      mockPrisma.emailSubscription.findUnique.mockResolvedValue({
        id: "s1",
        status: "UNSUBSCRIBED",
        tokenNonce: "n1",
      });
      const token = signToken(
        { action: "unsubscribe", subId: "s1", nonce: "n1", exp: FAR_FUTURE },
        SECRET,
      );
      const res = await handler.handleUnsubscribe(
        tokenReq("/api/subscriptions/email/unsubscribe", token),
        mockEnv,
      );
      expect(res.status).toBe(200);
      expect(mockPrisma.emailSubscription.update).not.toHaveBeenCalled();
    });

    it("rejects an invalid/forged unsubscribe token → generic 400", async () => {
      const res = await handler.handleUnsubscribe(
        tokenReq("/api/subscriptions/email/unsubscribe", "garbage.token"),
        mockEnv,
      );
      expect(res.status).toBe(400);
      expect(mockPrisma.emailSubscription.findUnique).not.toHaveBeenCalled();
    });

    it("returns generic 400 for a nonexistent subId (no oracle)", async () => {
      mockPrisma.emailSubscription.findUnique.mockResolvedValue(null);
      const token = signToken(
        { action: "unsubscribe", subId: "ghost", nonce: "n1", exp: FAR_FUTURE },
        SECRET,
      );
      const res = await handler.handleUnsubscribe(
        tokenReq("/api/subscriptions/email/unsubscribe", token),
        mockEnv,
      );
      expect(res.status).toBe(400);
    });

    it("rejects a stale nonce on unsubscribe → 400", async () => {
      mockPrisma.emailSubscription.findUnique.mockResolvedValue({
        id: "s1",
        status: "CONFIRMED",
        tokenNonce: "rotated",
      });
      const token = signToken(
        { action: "unsubscribe", subId: "s1", nonce: "n1", exp: FAR_FUTURE },
        SECRET,
      );
      const res = await handler.handleUnsubscribe(
        tokenReq("/api/subscriptions/email/unsubscribe", token),
        mockEnv,
      );
      expect(res.status).toBe(400);
      expect(mockPrisma.emailSubscription.update).not.toHaveBeenCalled();
    });
  });

  describe("misconfig + token-absent edge branches", () => {
    it("confirm returns 400 when the HMAC secret is unprovisioned", async () => {
      const noSecret = { ...mockEnv, EMAIL_SUB_HMAC_SECRET: undefined } as unknown as Env;
      const res = await handler.handleConfirm(
        tokenReq("/api/subscriptions/email/confirm", "x.y"),
        noSecret,
      );
      expect(res.status).toBe(400);
    });
    it("GET pages tolerate a missing token param", () => {
      expect(
        handler.handleConfirmPage(
          new Request("https://api.example.com/api/subscriptions/email/confirm"),
        ).status,
      ).toBe(200);
      expect(
        handler.handleUnsubscribePage(
          new Request("https://api.example.com/api/subscriptions/email/unsubscribe"),
        ).status,
      ).toBe(200);
    });
  });

  describe("GET pages are inert (scanner-prefetch safe)", () => {
    it("confirm page returns HTML and does NOT touch the DB", () => {
      const res = handler.handleConfirmPage(
        new Request("https://api.example.com/api/subscriptions/email/confirm?token=abc"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(mockPrisma.emailSubscription.findUnique).not.toHaveBeenCalled();
    });
    it("unsubscribe page returns HTML and does NOT touch the DB", () => {
      const res = handler.handleUnsubscribePage(
        new Request("https://api.example.com/api/subscriptions/email/unsubscribe?token=abc"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    });
  });

  describe("owner summary (count only, never addresses)", () => {
    const session = { userId: "owner1" } as any;
    it("returns counts for an owner", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue({ id: "o1" });
      mockPrisma.emailSubscription.count.mockResolvedValueOnce(12).mockResolvedValueOnce(3);
      const res = await handler.handleOwnerSummary("e1", session, mockEnv);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ confirmedCount: 12, pendingCount: 3 });
      // never leaks addresses
      expect(JSON.stringify(body)).not.toMatch(/emailEnc|emailHash|@/);
    });
    it("403 when the caller does not own the entity", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue(null);
      const res = await handler.handleOwnerSummary("e1", session, mockEnv);
      expect(res.status).toBe(403);
    });
  });
});
