/**
 * Integration (P0 launch blocker): POST /api/posts must actually persist.
 *
 * Drives the REAL create path — PostHandler.createPost → DataRouter.createPost
 * → real Prisma client → real Postgres (Docker Compose). The Post model has a
 * `radius PostRadius @default(NORMAL)` column and NO `visibility` column, so a
 * create that sends `visibility` throws PrismaClientValidationError ("Unknown
 * argument `visibility`") and the endpoint 500s. Unit tests mask this with
 * mocked Prisma clients; only a real client rejects unknown args.
 *
 * Also pins the legacy-visibility → radius mapping, grounded in the schema and
 * the working read paths (feed-handler visibility filter, ActivityPub audience
 * mapping, editPost's SHOUT-only federation gate):
 *
 *   "public"       → SHOUT   (everyone; AP public collection)
 *   "friends-only" → NORMAL  (close friends + inner circle; feed shows NORMAL
 *                             to friends)
 *   "private"      → WHISPER (inner circle only; AP bto)
 *   (neither)      → NORMAL  (schema default; fail-closed w.r.t. the
 *                             global_public_posting_enabled toggle)
 *
 * And the security consistency of the public-posting gate: radius=SHOUT is
 * public, so it must be gated by global_public_posting_enabled exactly like
 * the legacy visibility="public" — on create AND on edit.
 *
 * Runs in the setup-free integration-ci lane (real DATABASE_URL, no
 * test/setup.ts). Same bootstrap as text-moderation-fail-closed.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostHandler } from "../../src/lib/post-handler.js";
import type { Env } from "../../src/env.js";

// Hyperdrive guard: safe even under the broad integration config, whose
// test/setup.ts forces a fake hyperdrive URL.
const ENV_DB_URL = process.env.DATABASE_URL;
const TEST_DB_URL =
  ENV_DB_URL !== undefined && !ENV_DB_URL.includes("hyperdrive")
    ? ENV_DB_URL
    : "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const RUN_TAG = `p0-radius-${Date.now()}`;
const TENANT_ID = `tenant-${RUN_TAG}`;
const USER_ID = `21111111-2222-4333-8444-${Date.now().toString().slice(-12).padStart(12, "0")}`;
const USER_EMAIL = `${RUN_TAG}@test.example.com`;

let prisma: PrismaClient;
let handler: PostHandler;
let env: Env;

const session = {
  userId: USER_ID,
  email: USER_EMAIL,
  role: "END_USER",
  expiresAt: Date.now() + 3_600_000,
} as never;

const requestContext = {
  region: "US",
  requestId: `req-${RUN_TAG}`,
} as never;

function makeCreateRequest(body: Record<string, unknown>): Request {
  return new Request("https://api.test.example.com/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeEditRequest(
  postId: string,
  body: Record<string, unknown>,
): Request {
  return new Request(`https://api.test.example.com/api/posts/${postId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Set a GLOBAL (tenantId null) feature toggle; compound unique can't address
 * null via upsert, so find-then-create/update. Returns the previous enabled
 * state (undefined = row did not exist). */
async function setGlobalToggle(
  key: string,
  enabled: boolean,
): Promise<boolean | undefined> {
  const existing = await prisma.featureToggle.findFirst({
    where: { key, tenantId: null },
  });
  if (existing) {
    await prisma.featureToggle.update({
      where: { id: existing.id },
      data: { enabled },
    });
    return existing.enabled;
  }
  await prisma.featureToggle.create({ data: { key, enabled } });
  return undefined;
}

async function restoreGlobalToggle(
  key: string,
  previous: boolean | undefined,
): Promise<void> {
  const existing = await prisma.featureToggle.findFirst({
    where: { key, tenantId: null },
  });
  if (!existing) return;
  if (previous === undefined) {
    await prisma.featureToggle.delete({ where: { id: existing.id } });
  } else {
    await prisma.featureToggle.update({
      where: { id: existing.id },
      data: { enabled: previous },
    });
  }
}

async function createPostViaHandler(
  body: Record<string, unknown>,
): Promise<Response> {
  return handler.createPost(
    makeCreateRequest(body),
    session,
    env,
    requestContext,
    TENANT_ID,
  );
}

async function radiusInDb(postId: string): Promise<string | null> {
  const row = await prisma.post.findUnique({
    where: { id: postId },
    select: { radius: true },
  });
  return row?.radius ?? null;
}

let prevModerationToggle: boolean | undefined;
let prevPublicToggle: boolean | undefined;

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

  // Moderation OFF for this suite (persistence is under test, not the gate —
  // the gate has its own suite). Public posting starts DISABLED (the shipped
  // fail-closed default); individual tests flip it.
  prevModerationToggle = await setGlobalToggle(
    "content_moderation_enabled",
    false,
  );
  prevPublicToggle = await setGlobalToggle(
    "global_public_posting_enabled",
    false,
  );

  env = {
    DATABASE_URL: TEST_DB_URL,
    DEFAULT_REGION: "US",
    ENVIRONMENT: "test",
    SESSION_SECRET: "integration-test-secret-32-chars!!",
    APP_DOMAIN: "https://api.test.example.com",
  } as Env;

  handler = new PostHandler();
});

afterAll(async () => {
  await prisma.post.deleteMany({ where: { authorId: USER_ID } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
  await restoreGlobalToggle("content_moderation_enabled", prevModerationToggle);
  await restoreGlobalToggle("global_public_posting_enabled", prevPublicToggle);
  await prisma.$disconnect();
});

describe("P0 — POST /api/posts persists to the real radius column", () => {
  it("radius=WHISPER → 201 and the row is persisted with radius WHISPER (the P0 repro)", async () => {
    const response = await createPostViaHandler({
      text: "integration whisper post",
      radius: "WHISPER",
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(await radiusInDb(body.id)).toBe("WHISPER");
  });

  it("no radius/visibility → 201 with the schema default NORMAL", async () => {
    const response = await createPostViaHandler({
      text: "integration default-radius post",
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(await radiusInDb(body.id)).toBe("NORMAL");
  });

  it("legacy visibility=friends-only → 201, radius NORMAL", async () => {
    const response = await createPostViaHandler({
      text: "integration friends-only post",
      visibility: "friends-only",
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(await radiusInDb(body.id)).toBe("NORMAL");
  });

  it("legacy visibility=private → 201, radius WHISPER", async () => {
    const response = await createPostViaHandler({
      text: "integration private post",
      visibility: "private",
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(await radiusInDb(body.id)).toBe("WHISPER");
  });

  it("legacy visibility=public with the toggle ENABLED → 201, radius SHOUT", async () => {
    await setGlobalToggle("global_public_posting_enabled", true);
    try {
      const response = await createPostViaHandler({
        text: "integration public post",
        visibility: "public",
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(await radiusInDb(body.id)).toBe("SHOUT");
    } finally {
      await setGlobalToggle("global_public_posting_enabled", false);
    }
  });

  it("radius=SHOUT with public posting DISABLED → 403 PUBLIC_POSTING_DISABLED, nothing persisted (gate consistency)", async () => {
    const before = await prisma.post.count({ where: { authorId: USER_ID } });

    const response = await createPostViaHandler({
      text: "integration shout-while-disabled post",
      radius: "SHOUT",
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("PUBLIC_POSTING_DISABLED");
    expect(await prisma.post.count({ where: { authorId: USER_ID } })).toBe(
      before,
    );
  });
});

describe("P0 — PATCH /api/posts/:id (editPost) writes radius, not a phantom visibility column", () => {
  it("edit with legacy visibility=private → 200 and radius becomes WHISPER", async () => {
    const createResponse = await createPostViaHandler({
      text: "integration post to edit",
      radius: "NORMAL",
    });
    expect(createResponse.status).toBe(201);
    const { id: postId } = await createResponse.json();

    const response = await handler.editPost(
      postId,
      makeEditRequest(postId, {
        text: "integration post edited to private",
        visibility: "private",
      }),
      session,
      env,
      requestContext,
    );

    expect(response.status).toBe(200);
    expect(await radiusInDb(postId)).toBe("WHISPER");
  });

  it("edit to visibility=public while public posting is DISABLED → 403, radius unchanged (gate consistency)", async () => {
    const createResponse = await createPostViaHandler({
      text: "integration post kept non-public",
      radius: "WHISPER",
    });
    expect(createResponse.status).toBe(201);
    const { id: postId } = await createResponse.json();

    const response = await handler.editPost(
      postId,
      makeEditRequest(postId, {
        text: "integration attempted public edit",
        visibility: "public",
      }),
      session,
      env,
      requestContext,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("PUBLIC_POSTING_DISABLED");
    expect(await radiusInDb(postId)).toBe("WHISPER");
  });
});
