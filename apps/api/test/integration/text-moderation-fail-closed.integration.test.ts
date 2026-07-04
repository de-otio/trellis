/**
 * Integration test (T4): flagged or unverifiable post text is NOT persisted and
 * therefore NOT publicly served — against a real Postgres (Docker Compose).
 *
 * Drives the REAL PostHandler.createPost path end-to-end: real Zod validation,
 * real FeatureToggleService rows (content_moderation_enabled = true), the real
 * text-moderation seam (setTextModerationProvider), and the real
 * DataRouter/Prisma write path. Only the moderation PROVIDER is a programmable
 * test double — exactly the seam a production deploy injects.
 *
 * The proof, on both moderated write surfaces:
 *   POST path: quarantine → 400 / review → 503 / provider throw → 503, and in
 *       every case ZERO Post rows (flagged or unverifiable content is not
 *       persisted, so no read/feed path can serve it).
 *   COMMENT path: quarantine → 400 + zero PostComment rows, and approved →
 *       201 + one row. The approved case is the CONTROL proving the write path
 *       works — so the zero-rows above are the gate's doing, not a broken
 *       fixture. (The control runs on the comment path because the post path's
 *       DataRouter.createPost still sends the legacy `visibility` field, which
 *       the current Prisma schema — `radius` — rejects: a pre-existing,
 *       T4-unrelated bug reported in the task's blocker list.)
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostHandler } from "../../src/lib/post-handler.js";
import { CommentHandler } from "../../src/lib/comment-handler.js";
import {
  __resetTextModerationProviderForTests,
  setTextModerationProvider,
} from "../../src/lib/media/request-text-moderation.js";
import { MockTextModerationProvider } from "../../src/lib/media/text-moderation.js";
import type { ModerationVerdict } from "../../src/lib/media/moderation-provider.js";
import type { Env } from "../../src/env.js";

// Runs in the setup-free integration-ci lane with a REAL DATABASE_URL. The
// hyperdrive guard makes the file safe even if it is ever run under the broad
// integration config, whose test/setup.ts forces a fake hyperdrive URL.
const ENV_DB_URL = process.env.DATABASE_URL;
const TEST_DB_URL =
  ENV_DB_URL !== undefined && !ENV_DB_URL.includes("hyperdrive")
    ? ENV_DB_URL
    : "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const RUN_TAG = `t4-tmod-${Date.now()}`;
const TENANT_ID = `tenant-${RUN_TAG}`;
const USER_ID = `11111111-2222-4333-8444-${Date.now().toString().slice(-12).padStart(12, "0")}`;
const USER_EMAIL = `${RUN_TAG}@test.example.com`;

const SEED_POST_ID = `post-${RUN_TAG}`;

let prisma: PrismaClient;
let handler: PostHandler;
let commentHandler: CommentHandler;
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

function makeRequest(text: string): Request {
  return new Request("https://api.test.example.com/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // radius (current API shape); NOT the legacy `visibility` field, whose
    // DataRouter mapping predates the radius migration.
    body: JSON.stringify({ text, radius: "WHISPER" }),
  });
}

function inject(verdict: ModerationVerdict): void {
  setTextModerationProvider(new MockTextModerationProvider(verdict));
}

async function postsForUser(): Promise<number> {
  // Excludes the directly-seeded fixture post (comment target).
  return prisma.post.count({
    where: { authorId: USER_ID, id: { not: SEED_POST_ID } },
  });
}

async function commentsForUser(): Promise<number> {
  return prisma.postComment.count({ where: { authorId: USER_ID } });
}

function makeCommentRequest(text: string): Request {
  return new Request(
    `https://api.test.example.com/api/posts/${SEED_POST_ID}/comments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
}

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
  });
  await prisma.$connect();

  // Seed: tenant + moderation toggle ON (global row). The user row is created
  // by the handler's own upsert on the approved path.
  await prisma.tenant.create({
    data: {
      id: TENANT_ID,
      slug: TENANT_ID,
      displayName: TENANT_ID,
      type: "ORGANIZATION",
    },
  });
  // Global toggle row (tenantId null): the compound unique can't address null
  // via upsert, so find-then-create/update.
  const existingToggle = await prisma.featureToggle.findFirst({
    where: { key: "content_moderation_enabled", tenantId: null },
  });
  if (existingToggle) {
    await prisma.featureToggle.update({
      where: { id: existingToggle.id },
      data: { enabled: true },
    });
  } else {
    await prisma.featureToggle.create({
      data: { key: "content_moderation_enabled", enabled: true },
    });
  }

  // Seed the comment target: author user + one post row (direct write — the
  // comment path reads it via DataRouter.getPost).
  await prisma.user.create({
    data: { id: USER_ID, email: USER_EMAIL, handle: RUN_TAG, role: "END_USER" },
  });
  await prisma.post.create({
    data: {
      id: SEED_POST_ID,
      tenantId: TENANT_ID,
      authorId: USER_ID,
      text: "seeded comment target",
      dataRegion: "US",
    },
  });

  env = {
    DATABASE_URL: TEST_DB_URL,
    DEFAULT_REGION: "US",
    ENVIRONMENT: "test",
    SESSION_SECRET: "integration-test-secret-32-chars!!",
    APP_DOMAIN: "https://api.test.example.com",
  } as Env;

  handler = new PostHandler();
  commentHandler = new CommentHandler();
});

afterEach(() => {
  __resetTextModerationProviderForTests();
});

afterAll(async () => {
  await prisma.postComment.deleteMany({ where: { authorId: USER_ID } });
  await prisma.post.deleteMany({ where: { authorId: USER_ID } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
  // Leave the (pre-existing) global toggle row in place for other suites.
  await prisma.$disconnect();
});

describe("T4 — flagged post is NOT publicly served (real Postgres)", () => {
  it("quarantine verdict → 400 CONTENT_REJECTED and ZERO Post rows", async () => {
    inject({
      decision: "quarantine",
      labels: [{ category: "category_a", confidence: 0.99 }],
      provider: "mock-text",
    });

    const response = await handler.createPost(
      makeRequest("integration flagged text"),
      session,
      env,
      requestContext,
      TENANT_ID,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("CONTENT_REJECTED");
    // NOT persisted ⇒ nothing exists for any read/feed path to serve.
    expect(await postsForUser()).toBe(0);
  });

  it("review verdict (fault/budget) → 503 MODERATION_UNAVAILABLE and ZERO Post rows (fail-closed)", async () => {
    inject({ decision: "review", labels: [], provider: "mock-text" });

    const response = await handler.createPost(
      makeRequest("integration unverifiable text"),
      session,
      env,
      requestContext,
      TENANT_ID,
    );

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("MODERATION_UNAVAILABLE");
    expect(await postsForUser()).toBe(0);
  });

  it("provider that THROWS → 503 and ZERO Post rows (an outage cannot open the gate)", async () => {
    setTextModerationProvider({
      moderateText: async () => {
        throw new Error("hosted moderation API down");
      },
    });

    const response = await handler.createPost(
      makeRequest("integration outage text"),
      session,
      env,
      requestContext,
      TENANT_ID,
    );

    expect(response.status).toBe(503);
    expect(await postsForUser()).toBe(0);
  });

  it("COMMENT path: quarantine verdict → 400 and ZERO PostComment rows", async () => {
    inject({
      decision: "quarantine",
      labels: [{ category: "category_a", confidence: 0.99 }],
      provider: "mock-text",
    });

    const response = await commentHandler.createComment(
      SEED_POST_ID,
      makeCommentRequest("integration flagged comment"),
      session,
      env as never,
      requestContext,
      TENANT_ID,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("CONTENT_REJECTED");
    expect(await commentsForUser()).toBe(0);
  });

  it("CONTROL (comment path): approved verdict → 201 and the comment IS persisted", async () => {
    inject({ decision: "approved", labels: [], provider: "mock-text" });

    const response = await commentHandler.createComment(
      SEED_POST_ID,
      makeCommentRequest("integration friendly dog comment"),
      session,
      env as never,
      requestContext,
      TENANT_ID,
    );

    expect(response.status).toBe(201);
    expect(await commentsForUser()).toBe(1);
  });
});
