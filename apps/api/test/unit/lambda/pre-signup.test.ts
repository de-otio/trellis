/**
 * Unit Tests: Pre Signup trigger (WS-3.3 trigger-hook extraction).
 *
 * The invitation-gate LOGIC lives in `lib/identity/invitation-gate.ts`
 * (provider-neutral, over the KvStore port); the Lambda is a thin Cognito
 * shell. These tests are OUTCOME-equivalent to the pre-extraction raw-DynamoDB
 * suite — same accept/reject decisions, same exact user-facing messages —
 * exercised through the shell with an injected `MemoryKvStore` (the WS-1
 * seam pattern), plus core-level cases with a frozen clock.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";

import { handler, __setInvitationStoreForTest } from "../../../src/lambda/pre-signup.js";
import { assertInvitationValid } from "../../../src/lib/identity/invitation-gate.js";

function makeEvent(invitationCode?: string, clientMetadata?: Record<string, string>) {
  return {
    request: {
      userAttributes: {
        email: "user@example.com",
        ...(invitationCode ? { "custom:invitationCode": invitationCode } : {}),
      },
      clientMetadata: clientMetadata || {},
    },
    response: {
      autoConfirmUser: false,
      autoVerifyEmail: false,
      autoVerifyPhone: false,
    },
  } as any;
}

describe("PreSignup trigger (thin shell over the invitation gate)", () => {
  let store: MemoryKvStore;
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    store = new MemoryKvStore();
    __setInvitationStoreForTest(store);
  });

  afterEach(() => {
    __setInvitationStoreForTest(null);
  });

  it("accepts a valid invitation code and auto-confirms the invited user", async () => {
    await store.put("VALID-CODE", { used: false }, { expiresAt: nowSeconds() + 3600 });

    const result = await handler(makeEvent("VALID-CODE"), {} as any, () => {});

    // Passwordless magic-link sign-in needs a CONFIRMED user; invited sign-ups
    // are auto-confirmed/verified (entry is gated by the invitation code, and
    // the magic-link challenge is the real email-ownership/access gate).
    expect(result!.response.autoConfirmUser).toBe(true);
    expect(result!.response.autoVerifyEmail).toBe(true);
  });

  it("throws when no invitation code is provided", async () => {
    await expect(handler(makeEvent(), {} as any, () => {})).rejects.toThrow(
      "An invitation code is required to register.",
    );
  });

  it("throws when the invitation code is not found", async () => {
    await expect(handler(makeEvent("INVALID-CODE"), {} as any, () => {})).rejects.toThrow(
      "Invalid or expired invitation code.",
    );
  });

  it("throws when the invitation code has already been used", async () => {
    await store.put(
      "USED-CODE",
      { used: true, usedBy: "someone" },
      { expiresAt: nowSeconds() + 3600 },
    );
    await expect(handler(makeEvent("USED-CODE"), {} as any, () => {})).rejects.toThrow(
      "This invitation code has already been used.",
    );
  });

  it("accepts the invitation code from clientMetadata", async () => {
    await store.put("META-CODE", { used: false }, { expiresAt: nowSeconds() + 3600 });
    const result = await handler(
      makeEvent(undefined, { invitationCode: "META-CODE" }),
      {} as any,
      () => {},
    );
    expect(result!.response.autoConfirmUser).toBe(true);
  });

  it("propagates store failures (allows the identity provider to retry)", async () => {
    const failing = new MemoryKvStore();
    failing.get = async () => {
      throw new Error("KV unavailable");
    };
    __setInvitationStoreForTest(failing);
    await expect(handler(makeEvent("VALID-CODE"), {} as any, () => {})).rejects.toThrow(
      "KV unavailable",
    );
  });
});

describe("assertInvitationValid (core, frozen clock)", () => {
  it("reports 'expired' for a present-but-expired record (includeExpired read parity)", async () => {
    // Store clock frozen in the past so the write is accepted, gate clock later.
    let storeNow = 1_000_000_000;
    const store = new MemoryKvStore({ now: () => storeNow });
    await store.put("EXPIRED-CODE", { used: false }, { expiresAt: 1_000_100 });

    await expect(
      assertInvitationValid("EXPIRED-CODE", { store, now: () => 1_000_200_000 }),
    ).rejects.toThrow("This invitation code has expired.");
  });

  it("used wins over expired (check order parity)", async () => {
    const store = new MemoryKvStore({ now: () => 1_000_000_000 });
    await store.put("USED-EXPIRED", { used: true }, { expiresAt: 1_000_100 });
    await expect(
      assertInvitationValid("USED-EXPIRED", { store, now: () => 1_000_200_000 }),
    ).rejects.toThrow("This invitation code has already been used.");
  });

  it("a record without an expiry never expires", async () => {
    const store = new MemoryKvStore();
    await store.put("NO-TTL", { used: false });
    await expect(assertInvitationValid("NO-TTL", { store })).resolves.toBeUndefined();
  });

  it("maps a separator-carrying code to the fail-closed 'invalid' outcome", async () => {
    const store = new MemoryKvStore();
    await expect(assertInvitationValid("evil:code", { store })).rejects.toThrow(
      "Invalid or expired invitation code.",
    );
    await expect(assertInvitationValid("evil#code", { store })).rejects.toThrow(
      "Invalid or expired invitation code.",
    );
  });

  it("looks the code up exactly as submitted (no case transform)", async () => {
    const store = new MemoryKvStore();
    await store.put("UPPER-CODE", { used: false });
    await expect(assertInvitationValid("upper-code", { store })).rejects.toThrow(
      "Invalid or expired invitation code.",
    );
  });
});
