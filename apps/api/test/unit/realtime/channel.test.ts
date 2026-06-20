/**
 * Channel naming + authorization (the security boundary).
 *
 * Covers: channelName round-trips through parseChannel; parseChannel returns
 * null on malformed input; channelFor builds user-scoped channels;
 * authorizeSubscription DENIES cross-tenant and cross-user, ALLOWS exact match,
 * and DENIES deferred conversation/thread scopes.
 */

import { describe, expect, it } from "vitest";
import {
  channelName,
  parseChannel,
  channelFor,
  authorizeSubscription,
} from "../../../src/lib/realtime/index.js";
import type {
  Channel,
  VerifiedIdentity,
} from "../../../src/lib/realtime/index.js";

describe("channelName / parseChannel", () => {
  it("produces the canonical /{kind}/{tenantId}/{scopeType}/{scopeId} path", () => {
    const c: Channel = {
      kind: "wakeup",
      tenantId: "t1",
      scopeType: "user",
      scopeId: "u1",
    };
    expect(channelName(c)).toBe("/wakeup/t1/user/u1");
  });

  it("round-trips through parseChannel for every v1 kind", () => {
    for (const kind of ["wakeup", "setting_sync", "safety"] as const) {
      const c = channelFor(kind, { tenantId: "tenant-x", userId: "user-y" });
      const parsed = parseChannel(channelName(c));
      expect(parsed).toEqual(c);
    }
  });

  it("round-trips deferred conversation/thread scopes (taxonomy reserved)", () => {
    const c: Channel = {
      kind: "message",
      tenantId: "t",
      scopeType: "conversation",
      scopeId: "conv-1",
    };
    expect(parseChannel(channelName(c))).toEqual(c);
  });

  it("channelName rejects empty or slash-bearing segments", () => {
    expect(() =>
      channelName({ kind: "wakeup", tenantId: "", scopeType: "user", scopeId: "u" }),
    ).toThrow();
    expect(() =>
      channelName({ kind: "wakeup", tenantId: "a/b", scopeType: "user", scopeId: "u" }),
    ).toThrow();
  });

  it("parseChannel returns null on malformed input", () => {
    const bad = [
      "",
      "wakeup/t/user/u", // missing leading slash
      "/wakeup/t/user", // too few segments
      "/wakeup/t/user/u/extra", // too many segments
      "/bogus/t/user/u", // unknown kind
      "/wakeup/t/bogus/u", // unknown scopeType
      "/wakeup//user/u", // empty tenant
      "/wakeup/t/user/", // empty scopeId
      "//wakeup/t/user/u", // leading double slash
    ];
    for (const path of bad) {
      expect(parseChannel(path)).toBeNull();
    }
  });
});

describe("authorizeSubscription — THE security boundary", () => {
  const id: VerifiedIdentity = { userId: "alice", tenantId: "acme" };

  it("ALLOWS an exact tenant+user match on a user-scoped channel", () => {
    const c = channelFor("wakeup", { tenantId: "acme", userId: "alice" });
    expect(authorizeSubscription(id, c)).toBe(true);
  });

  it("DENIES cross-tenant (same user id, different tenant)", () => {
    const c = channelFor("wakeup", { tenantId: "evilcorp", userId: "alice" });
    expect(authorizeSubscription(id, c)).toBe(false);
  });

  it("DENIES cross-user (same tenant, different user id)", () => {
    const c = channelFor("wakeup", { tenantId: "acme", userId: "bob" });
    expect(authorizeSubscription(id, c)).toBe(false);
  });

  it("DENIES deferred conversation/thread scopes even within the tenant", () => {
    const conv: Channel = {
      kind: "message",
      tenantId: "acme",
      scopeType: "conversation",
      scopeId: "alice", // even if scopeId equals userId
    };
    expect(authorizeSubscription(id, conv)).toBe(false);
  });

  it("authorize <=> (tenant equal AND user equal) for user-scoped channels", () => {
    // Exhaustive small matrix as a stand-in property check.
    const tenants = ["acme", "other"];
    const users = ["alice", "bob"];
    for (const t of tenants) {
      for (const u of users) {
        const c = channelFor("safety", { tenantId: t, userId: u });
        const expected = t === id.tenantId && u === id.userId;
        expect(authorizeSubscription(id, c)).toBe(expected);
      }
    }
  });
});
