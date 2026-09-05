/**
 * Integration: the scoped extension surface cannot be used unbound.
 *
 * This is the outcome assertion the unit lane structurally CANNOT make, and the
 * reason is the finding itself. The C1 fix rests on a claim about Prisma:
 * **an `undefined` value in a `where` is not a predicate, it is no filter at
 * all.** If that claim is true, the `{ tenantId: undefined }` clause the
 * planner used to build turned a scoped read into a platform-wide one. Every
 * unit test asserting that fact does so against a fake delegate, and a fake
 * asserts whatever its author believed — the fake in
 * `test/unit/extension-scoped-db.test.ts` compares with `===`, under which an
 * undefined tenant matches ZERO rows and the bug is invisible. Only real
 * Postgres evaluating a real Prisma clause settles it.
 *
 * So this suite pins two things:
 *   1. the PREMISE — `{ tenantId: undefined }` really does return every
 *      tenant's rows, so the unit fake's semantics are the real client's;
 *   2. the OUTCOME — the scoped surface, handed an unusable binding, returns
 *      nothing rather than everything.
 *
 * The destructive half of C1 (`deleteMany` with an undefined binding emptying
 * the table) is deliberately NOT exercised here. Against a real database, a
 * test that proves a platform-wide delete is a test that PERFORMS one the day
 * the guard regresses. It stays in the unit lane, where the blast radius is an
 * in-memory array. (Quality sweep 2026-09-05, C1.)
 *
 * Runs in the setup-free integration-ci lane (real DATABASE_URL, no
 * test/setup.ts). Same bootstrap as post-read-isolation.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantId } from "@de-otio/trellis-extension-api";
import {
  buildScopedModelMetas,
  createScopedDb,
  type RawPrismaLike,
} from "../../src/lib/extension-scoped-db.js";

// Hyperdrive guard: safe even under the broad integration config, whose
// test/setup.ts forces a fake hyperdrive URL.
const ENV_DB_URL = process.env.DATABASE_URL;
const TEST_DB_URL =
  ENV_DB_URL !== undefined && !ENV_DB_URL.includes("hyperdrive")
    ? ENV_DB_URL
    : "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const RUN = `ext-tenant-bind-${Date.now()}`;
const TENANT_A = `tenant-a-${RUN}`;
const TENANT_B = `tenant-b-${RUN}`;

const uuid = (n: number) =>
  `41111111-2222-4333-8444-${String(n).padStart(12, "0")}`;
const AUTHOR_A = uuid(1);
const AUTHOR_B = uuid(2);

const tid = (t: unknown) => t as TenantId;

let prisma: PrismaClient;

async function makeUser(id: string, personalTenantId: string) {
  await prisma.tenant.create({
    data: {
      id: personalTenantId,
      slug: personalTenantId,
      displayName: personalTenantId,
      type: "PERSONAL",
    },
  });
  await prisma.user.create({
    data: {
      id,
      email: `${id}@test.example.com`,
      handle: `h-${id.slice(-8)}-${RUN.slice(-6)}`,
      personalTenantId,
      dataRegion: "US",
    },
  });
}

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
  });
  await prisma.$connect();

  for (const id of [TENANT_A, TENANT_B]) {
    await prisma.tenant.create({
      data: { id, slug: id, displayName: id, type: "ORGANIZATION" },
    });
  }
  await makeUser(AUTHOR_A, `${RUN}-pt-a`);
  await makeUser(AUTHOR_B, `${RUN}-pt-b`);

  await prisma.post.createMany({
    data: [
      {
        id: `${RUN}-a`,
        text: "tenant a post",
        authorId: AUTHOR_A,
        tenantId: TENANT_A,
        radius: "SHOUT",
        dataRegion: "US",
      },
      {
        id: `${RUN}-b`,
        text: "tenant b post",
        authorId: AUTHOR_B,
        tenantId: TENANT_B,
        radius: "SHOUT",
        dataRegion: "US",
      },
    ],
  });
});

afterAll(async () => {
  await prisma.post.deleteMany({ where: { id: { startsWith: RUN } } });
  await prisma.user.deleteMany({ where: { id: { in: [AUTHOR_A, AUTHOR_B] } } });
  await prisma.tenant.deleteMany({
    where: { id: { in: [TENANT_A, TENANT_B, `${RUN}-pt-a`, `${RUN}-pt-b`] } },
  });
  await prisma.$disconnect();
});

describe("Prisma semantics the C1 fix depends on", () => {
  it("treats `{ tenantId: undefined }` as NO filter, not as `IS NULL`", async () => {
    const rows = await prisma.post.findMany({
      where: { id: { startsWith: RUN }, tenantId: undefined },
      select: { id: true },
    });
    // Both tenants' rows come back: the undefined clause filtered nothing.
    // This is the whole mechanism of C1.
    expect(rows.map((r) => r.id).sort()).toEqual([`${RUN}-a`, `${RUN}-b`]);
  });

  it("filters normally for a real tenant id", async () => {
    const rows = await prisma.post.findMany({
      where: { id: { startsWith: RUN }, tenantId: TENANT_A },
      select: { id: true },
    });
    expect(rows.map((r) => r.id)).toEqual([`${RUN}-a`]);
  });
});

describe("the scoped surface with an unusable binding", () => {
  const metas = buildScopedModelMetas();

  it("returns no rows rather than every tenant's rows", async () => {
    const db = createScopedDb(prisma as unknown as RawPrismaLike, tid(undefined), metas);
    const rows = await db.post
      .findMany({ where: { id: { startsWith: RUN } } })
      .catch(() => [] as unknown[]);
    expect(rows).toEqual([]);
  });

  it("still reads exactly its own tenant's rows when bound", async () => {
    const db = createScopedDb(prisma as unknown as RawPrismaLike, tid(TENANT_A), metas);
    const rows = (await db.post.findMany({
      where: { id: { startsWith: RUN } },
      select: { id: true },
    })) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([`${RUN}-a`]);
  });
});
