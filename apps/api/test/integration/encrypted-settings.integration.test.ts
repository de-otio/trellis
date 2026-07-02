/**
 * WS5 — encrypted-settings state-sync integration test against a real Postgres
 * (Docker Compose). Exercises the load-bearing behaviors that a mock cannot
 * prove: the conditional-UPDATE CAS at the DB (optimistic-concurrency race) and
 * the If-None-Match / 304 idle fast path end-to-end through the handler.
 *
 * Excluded from the default unit lane (see vitest.config.ts); runs in the
 * integration lane with DATABASE_URL pointing at the local Postgres.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaEncryptedSettingsStore } from "../../src/lib/encrypted-settings/encrypted-settings-store.js";
import { EncryptedSettingsHandler } from "../../src/lib/encrypted-settings/encrypted-settings-handler.js";
import type { SettingsConfig } from "../../src/lib/encrypted-settings/types.js";

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const NS = "feed_filters";
const TENANT = "tenant-es-itest";
const config: SettingsConfig = {
  allowedNamespaces: new Set([NS]),
  maxSettingBytes: 65536,
};

let pool: Pool;
let prisma: PrismaClient;
let store: PrismaEncryptedSettingsStore;

async function makeUser(tag: string): Promise<string> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const u = await prisma.user.create({
    data: {
      email: `es-itest-${tag}-${unique}@test.example.com`,
      handle: `esitest-${tag}-${unique}`.slice(0, 32),
      role: "END_USER",
    },
  });
  return u.id;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DB_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  await prisma.$connect();
  store = new PrismaEncryptedSettingsStore(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
});

describe("PrismaEncryptedSettingsStore (real Postgres)", () => {
  let userId: string;

  beforeEach(async () => {
    userId = await makeUser("store");
  });

  it("first write creates version 1; matching expectVersion increments", async () => {
    const first = await store.put(userId, NS, { ciphertext: "A", version: 0, updatedAt: "" }, 0);
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error("unreachable");
    expect(first.stored.version).toBe(1);

    const second = await store.put(userId, NS, { ciphertext: "B", version: 1, updatedAt: "" }, 1);
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) throw new Error("unreachable");
    expect(second.stored.version).toBe(2);
    expect(second.stored.ciphertext).toBe("B");
  });

  it("optimistic-concurrency race: two PUTs at the same version — one wins, one conflicts", async () => {
    await store.put(userId, NS, { ciphertext: "base", version: 0, updatedAt: "" }, 0); // v1

    const [a, b] = await Promise.all([
      store.put(userId, NS, { ciphertext: "edit-A", version: 1, updatedAt: "" }, 1),
      store.put(userId, NS, { ciphertext: "edit-B", version: 1, updatedAt: "" }, 1),
    ]);

    const wins = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ ok: false, reason: "version_conflict" });

    // The winning write moved the version to 2; the conflict reports current.
    const current = await store.get(userId, NS);
    expect(current?.version).toBe(2);
    const conflict = conflicts[0];
    if (conflict.ok) throw new Error("unreachable");
    expect(conflict.current?.version).toBe(2);
  });

  it("stale expectVersion conflicts and returns the server's current blob", async () => {
    await store.put(userId, NS, { ciphertext: "v1", version: 0, updatedAt: "" }, 0); // v1
    await store.put(userId, NS, { ciphertext: "v2", version: 1, updatedAt: "" }, 1); // v2

    const stale = await store.put(userId, NS, { ciphertext: "x", version: 1, updatedAt: "" }, 1);
    expect(stale).toMatchObject({ ok: false, reason: "version_conflict" });
    if (stale.ok) throw new Error("unreachable");
    expect(stale.current.version).toBe(2);
    expect(stale.current.ciphertext).toBe("v2");
  });

  it("cascade: deleting the user removes the blob", async () => {
    await store.put(userId, NS, { ciphertext: "doomed", version: 0, updatedAt: "" }, 0);
    await prisma.user.delete({ where: { id: userId } });
    const rows = await prisma.encryptedUserSetting.findMany({ where: { userId } });
    expect(rows).toHaveLength(0);
  });
});

describe("EncryptedSettingsHandler over real Postgres", () => {
  let handler: EncryptedSettingsHandler;
  let userId: string;

  beforeEach(async () => {
    handler = new EncryptedSettingsHandler(store, config);
    userId = await makeUser("handler");
  });

  it("PUT then GET returns the blob; a second GET with If-None-Match is 304", async () => {
    const put = await handler.handlePut(userId, TENANT, NS, { ciphertext: "CT", expectVersion: 0 });
    expect(put.status).toBe(200);
    const { version, changeToken } = await put.json();
    expect(version).toBe(1);

    const get1 = await handler.handleGet(userId, NS, null);
    expect(get1.status).toBe(200);
    expect(get1.headers.get("etag")).toBe(changeToken);
    expect((await get1.json()).ciphertext).toBe("CT");

    const get2 = await handler.handleGet(userId, NS, changeToken);
    expect(get2.status).toBe(304);
    expect(await get2.text()).toBe("");
  });

  it("cross-user isolation: user B does not see user A's blob", async () => {
    const userB = await makeUser("handler-b");
    await handler.handlePut(userId, TENANT, NS, { ciphertext: "A-secret", expectVersion: 0 });

    const bGet = await handler.handleGet(userB, NS, null);
    expect(bGet.status).toBe(404);
  });

  it("stale PUT returns 409 with the server's current blob", async () => {
    await handler.handlePut(userId, TENANT, NS, { ciphertext: "v1", expectVersion: 0 });
    await handler.handlePut(userId, TENANT, NS, { ciphertext: "v2", expectVersion: 1 });

    const stale = await handler.handlePut(userId, TENANT, NS, { ciphertext: "x", expectVersion: 1 });
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.current.version).toBe(2);
    expect(body.current.ciphertext).toBe("v2");
  });
});
