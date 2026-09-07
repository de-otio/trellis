/**
 * Integration: DataRouter.createPost's post-create transaction must persist a
 * tagged entity as a real `PostSubject` row (`post_subjects`).
 *
 * The transaction used to call `(tx as any).postEntity.createMany(...)` —
 * there is no `postEntity` Prisma model. The join table is `PostSubject`
 * (`postId`/`entityId`/`isPrimary`, `@@unique([postId, entityId])`,
 * `@@map("post_subjects")`; see prisma/schema.prisma). On a real Prisma
 * client `tx.postEntity` is `undefined`, so the transaction threw for every
 * post created with an `entityRefs` tag. The unit suite masked this because
 * it mocks a `postEntity` delegate on the transaction client, which doesn't
 * exist on a real one; only a real Prisma client against real Postgres can
 * catch it.
 *
 * Calls `DataRouter.createPost` directly (no request, no session) — the
 * narrowest real-Prisma exercise of the fixed code, deliberately bypassing
 * `PostHandler`'s separate (non-transactional, best-effort) graph-sync dual
 * write, which would otherwise re-write the same `post_subjects` row via
 * `syncPostSubjects` and mask what this transaction itself wrote. Runs in
 * the setup-free integration-ci lane (real DATABASE_URL, no test/setup.ts) —
 * same bootstrap shape as post-create-radius.integration.test.ts.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataRouter, type DataRouterEnv } from "../../src/lib/data-router.js";

// Hyperdrive guard: safe even under the broad integration config, whose
// test/setup.ts forces a fake hyperdrive URL.
const ENV_DB_URL = process.env.DATABASE_URL;
const TEST_DB_URL =
  ENV_DB_URL !== undefined && !ENV_DB_URL.includes("hyperdrive")
    ? ENV_DB_URL
    : "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const RUN_TAG = `post-subject-${Date.now()}`;
const TENANT_ID = `tenant-${RUN_TAG}`;
const USER_ID = `31111111-2222-4333-8444-${Date.now().toString().slice(-12).padStart(12, "0")}`;
const USER_EMAIL = `${RUN_TAG}@test.example.com`;
const USER_HANDLE = `handle-${RUN_TAG}`;

let prisma: PrismaClient;
let env: DataRouterEnv;
// Assigned in beforeAll to the DB-generated cuid.
let entityId: string;

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
  });
  await prisma.$connect();

  await prisma.tenant.create({
    data: {
      id: TENANT_ID,
      slug: TENANT_ID,
      displayName: TENANT_ID,
      type: "ORGANIZATION",
    },
  });

  // Post.authorId FKs to User.
  await prisma.user.create({
    data: {
      id: USER_ID,
      email: USER_EMAIL,
      handle: USER_HANDLE,
    },
  });

  // PostSubject.entityId FKs to Entity. No session is passed to
  // DataRouter.createPost below, so validateEntityTagging's ownership check
  // never runs — only the entity row itself needs to exist for the FK.
  const entity = await prisma.entity.create({
    data: {
      tenantId: TENANT_ID,
      name: `Entity ${RUN_TAG}`,
    },
  });
  entityId = entity.id;

  env = {
    DATABASE_URL: TEST_DB_URL,
    DEFAULT_REGION: "US",
    ENVIRONMENT: "test",
    SESSION_SECRET: "integration-test-secret-32-chars!!",
    APP_DOMAIN: "https://api.test.example.com",
  } as unknown as DataRouterEnv;
});

afterAll(async () => {
  await prisma.postSubject.deleteMany({ where: { entityId } });
  await prisma.post.deleteMany({ where: { authorId: USER_ID } });
  await prisma.entity.deleteMany({ where: { id: entityId } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
  await prisma.$disconnect();
});

describe("DataRouter.createPost with a tagged entity persists a real PostSubject row", () => {
  it("creates the post and writes exactly one post_subjects row (postId, entityId, isPrimary=false)", async () => {
    const post = await DataRouter.createPost(
      {
        authorId: USER_ID,
        text: "integration post tagging an entity",
        tenantId: TENANT_ID,
        entityRefs: [entityId],
      },
      "US",
      env,
    );

    const rows = await prisma.postSubject.findMany({
      where: { postId: post.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      postId: post.id,
      entityId,
      isPrimary: false,
    });
  });

  it("duplicate entity ids in the same request dedupe to a single row (no unique-constraint throw)", async () => {
    const post = await DataRouter.createPost(
      {
        authorId: USER_ID,
        text: "integration post tagging the same entity twice",
        tenantId: TENANT_ID,
        entityRefs: [entityId, entityId],
      },
      "US",
      env,
    );

    const rows = await prisma.postSubject.findMany({
      where: { postId: post.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(entityId);
  });
});
