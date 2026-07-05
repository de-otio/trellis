/**
 * GDPR erasure e2e (AR-CRITIC H2/H3 — AR7 / GDPR Art. 17).
 *
 * The pre-existing coverage at this seam could not catch a zero-byte-erasure
 * regression:
 *   - `test/e2e/gdpr.test.ts` asserts `res.status <= 500` (a 500 passes green)
 *     and never touches account deletion;
 *   - `test/unit/lambda/delete-account-worker.test.ts` mocks the WHOLE
 *     `deleteUserData` composition, so the erasure internals (eraseUserMedia,
 *     the soft-delete-into-GC handoff, the staging-key computation) are never
 *     executed.
 *
 * This suite runs the REAL thing, end to end, against local docker infra:
 *   - REAL Postgres (dedicated throwaway database, `prisma db push`-ed schema)
 *   - REAL S3 semantics (localstack) holding actual staging/cas bytes
 *   - REAL `delete-account-worker` handler → REAL `deleteUserData` →
 *     REAL `eraseUserMedia` → REAL `deleteStagingObjects`
 *   - REAL `nightly-cron` handler for the soft-deleted-media GC purge that
 *     reclaims the CAS bytes (the worker deliberately never deletes `cas/*`)
 *
 * The ONLY substituted seams are transport/config, never behavior:
 *   - S3Client / DynamoDBClient are the REAL SDK classes with their endpoint
 *     redirected to the local docker services (forcePathStyle for localstack);
 *   - `getLambdaPrisma` (Secrets Manager + forced RDS TLS, neither of which
 *     exists locally) returns a REAL PrismaClient on the dedicated test DB.
 *
 * MUST-FAIL property: if erasure leaves bytes behind (e.g. eraseUserMedia
 * returns without soft-deleting, staging keys are not reported/deleted, or the
 * GC purge stops deleting S3 objects), the zero-bytes assertions below go red.
 *
 * Requires: docker compose up (postgres:5432, dynamodb:8000, localstack:4566).
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Local-infra endpoints (env-overridable; defaults match docker-compose.yml)
// ---------------------------------------------------------------------------
const S3_ENDPOINT = process.env.E2E_S3_ENDPOINT ?? "http://localhost:4566";
const DDB_ENDPOINT = process.env.E2E_DDB_ENDPOINT ?? "http://localhost:8000";
const PG_ADMIN_URL =
  process.env.E2E_PG_ADMIN_URL ??
  "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";
const TEST_DB_NAME = "trellis_gdpr_erasure_e2e";
const TEST_DB_URL = PG_ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);

// Unique per run so a shared localstack/dynamodb-local never collides with
// another worktree's tests.
const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const BUCKET = `gdpr-erasure-e2e-${RUN_ID}`;
const TABLE = `gdpr-erasure-e2e-${RUN_ID}`;

// Handler modules read these at import time — set them BEFORE the dynamic
// imports below (imports happen inside tests, after this module executes).
process.env.AWS_REGION = "us-east-1";
process.env.MEDIA_BUCKET_NAME = BUCKET;
process.env.DYNAMODB_TABLE = TABLE;
// Plaintext tombstone key so resolvePseudonymSecret never calls SSM.
process.env.REPORT_PSEUDONYM_SECRET = "gdpr-e2e-test-pseudonym-secret";
// Ensure the worker's optional AWS side effects stay off.
delete process.env.COGNITO_USER_POOL_ID;
delete process.env.DOMAIN;

// ---------------------------------------------------------------------------
// Transport redirection (NOT behavior mocks): the real SDK client classes,
// pointed at local docker services. Everything the workers send — real
// PutObject/DeleteObjects/HeadObject, real DynamoDB conditional writes — runs
// against a real implementation.
// ---------------------------------------------------------------------------
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  class LocalstackS3 extends actual.S3Client {
    constructor(cfg: ConstructorParameters<typeof actual.S3Client>[0] = {}) {
      super({
        ...cfg,
        endpoint: S3_ENDPOINT,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      });
    }
  }
  return { ...actual, S3Client: LocalstackS3 };
});

vi.mock("@aws-sdk/client-dynamodb", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@aws-sdk/client-dynamodb")>();
  class LocalDynamo extends actual.DynamoDBClient {
    constructor(
      cfg: ConstructorParameters<typeof actual.DynamoDBClient>[0] = {},
    ) {
      super({
        ...cfg,
        endpoint: DDB_ENDPOINT,
        region: "us-east-1",
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      });
    }
  }
  return { ...actual, DynamoDBClient: LocalDynamo };
});

// The ONE substituted app seam: the Lambda DB connection factory (it requires
// Secrets Manager + RDS-style forced TLS). Returns a REAL PrismaClient bound
// to the dedicated test database — the erasure composition itself is real.
vi.mock("../../src/lib/lambda-prisma.js", () => ({
  getLambdaPrisma: async () => getTestPrisma(),
  withLambdaDbBreaker: async <T,>(fn: () => Promise<T>) => fn(),
}));

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import {
  casKey,
  isCasKeyError,
  pendingKey,
  processingKey,
} from "../../src/lib/media/cas-keys.js";

let prisma: PrismaClient | null = null;
function getTestPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
    });
  }
  return prisma;
}

const s3 = new S3Client({});
const dynamo = new DynamoDBClient({});

/** Build a cas-keys result or fail the test loudly (keys must be canonical). */
function mustKey(result: string | { kind: string; raw: string }): string {
  if (typeof result !== "string" || isCasKeyError(result as never)) {
    throw new Error(`cas-keys rejected input: ${JSON.stringify(result)}`);
  }
  return result;
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NotFound" || name === "NoSuchKey" || name === "404") {
      return false;
    }
    throw err;
  }
}

async function putBytes(key: string, bytes: Buffer): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes }),
  );
}

/** cuid-shaped id accepted by the cas-keys allowlist (`c` + 24 [a-z0-9]). */
function cuidLike(seed: string): string {
  const hex = createHash("sha256").update(seed + RUN_ID).digest("hex");
  return `c${hex.slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Seed state shared across the sequential tests below
// ---------------------------------------------------------------------------
let userAId: string;
let userBId: string;
let tenantId: string;
let m1Id: string; // user A's own media — must be fully erased (rows + bytes)
let m2Id: string; // shared media referenced by user B's post — bytes retained
let m1Keys: {
  pending: string;
  processing: string;
  original: string;
  thumbnail: string;
  optimized: string;
};
let m2Keys: { pending: string; original: string };

describe("GDPR erasure e2e — real worker, real DB, real bytes (AR7 / H2+H3)", () => {
  beforeAll(async () => {
    // 1. Dedicated throwaway database. NEVER reuse trellis_dev: the nightly
    //    GC purge below hard-deletes every soft-deleted MediaFile older than
    //    7 days in whatever DB it points at.
    const { Client } = await import("pg");
    const admin = new Client({ connectionString: PG_ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
    await admin.end();

    // The schema needs PostGIS (geography columns) — enable it in the new DB.
    const ext = new Client({ connectionString: TEST_DB_URL });
    await ext.connect();
    await ext.query("CREATE EXTENSION IF NOT EXISTS postgis");
    await ext.end();

    // 2. Push the real schema into it.
    const apiDir = path.resolve(__dirname, "../..");
    execSync(`npx prisma db push --url "${TEST_DB_URL}"`, {
      cwd: apiDir,
      stdio: "pipe",
      env: {
        ...process.env,
        DATABASE_URL: TEST_DB_URL,
        DIRECT_DATABASE_URL: TEST_DB_URL,
      },
    });

    // 3. Local S3 bucket + DynamoDB cron-lock table.
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await dynamo.send(
      new CreateTableCommand({
        TableName: TABLE,
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );

    // 4. Seed: tenant, users A + B, media + posts + REAL bytes in S3.
    const db = getTestPrisma();

    const tenant = await db.tenant.create({
      data: {
        slug: `gdpr-e2e-${RUN_ID}`,
        displayName: "GDPR erasure e2e tenant",
        type: "PERSONAL",
      },
    });
    tenantId = tenant.id;

    const userA = await db.user.create({
      data: {
        email: `gdpr-e2e-a-${RUN_ID}@example.com`,
        handle: `gdpr-e2e-a-${RUN_ID}`,
      },
    });
    userAId = userA.id;
    const userB = await db.user.create({
      data: {
        email: `gdpr-e2e-b-${RUN_ID}@example.com`,
        handle: `gdpr-e2e-b-${RUN_ID}`,
      },
    });
    userBId = userB.id;

    // Real (deterministic) bytes; contentHash is the ACTUAL sha256 of them.
    const bytes1 = Buffer.from(`m1-original-bytes-${RUN_ID}`.repeat(64));
    const bytes2 = Buffer.from(`m2-shared-bytes-${RUN_ID}`.repeat(64));
    const h1 = createHash("sha256").update(bytes1).digest("hex");
    const h2 = createHash("sha256").update(bytes2).digest("hex");
    const u1 = cuidLike("upload-m1");
    const u2 = cuidLike("upload-m2");

    m1Keys = {
      pending: mustKey(pendingKey(tenantId, u1)),
      processing: mustKey(processingKey(tenantId, h1)),
      original: mustKey(casKey(tenantId, h1)),
      thumbnail: mustKey(casKey(tenantId, h1, "thumbnail")),
      optimized: mustKey(casKey(tenantId, h1, "optimized")),
    };
    m2Keys = {
      pending: mustKey(pendingKey(tenantId, u2)),
      original: mustKey(casKey(tenantId, h2)),
    };

    await putBytes(m1Keys.pending, bytes1);
    await putBytes(m1Keys.processing, bytes1);
    await putBytes(m1Keys.original, bytes1);
    await putBytes(m1Keys.thumbnail, bytes1.subarray(0, 256));
    await putBytes(m1Keys.optimized, bytes1.subarray(0, 512));
    await putBytes(m2Keys.pending, bytes2);
    await putBytes(m2Keys.original, bytes2);

    const m1 = await db.mediaFile.create({
      data: {
        tenantId,
        contentHash: h1,
        mimeType: "image/jpeg",
        size: bytes1.length,
        uploadId: u1,
        originalKey: m1Keys.original,
        thumbnailKey: m1Keys.thumbnail,
        optimizedKey: m1Keys.optimized,
        lifecycle: "APPROVED",
        uploadedBy: userAId,
      },
    });
    m1Id = m1.id;
    const m2 = await db.mediaFile.create({
      data: {
        tenantId,
        contentHash: h2,
        mimeType: "image/jpeg",
        size: bytes2.length,
        uploadId: u2,
        originalKey: m2Keys.original,
        lifecycle: "APPROVED",
        uploadedBy: userAId,
      },
    });
    m2Id = m2.id;

    // A's own post references M1 (must not block erasure — deleteUserData
    // removes A's posts/junctions first). B's post references M2 (must force
    // retention — deleting M2's bytes would destroy B's published content).
    const postA = await db.post.create({
      data: { tenantId, authorId: userAId, text: "post by A with M1" },
    });
    await db.postMedia.create({
      data: { tenantId, postId: postA.id, mediaId: m1Id },
    });
    const postB = await db.post.create({
      data: { tenantId, authorId: userBId, text: "post by B with M2" },
    });
    await db.postMedia.create({
      data: { tenantId, postId: postB.id, mediaId: m2Id },
    });
  }, 180_000);

  afterAll(async () => {
    // Best-effort cleanup of the run-scoped resources.
    try {
      const listed = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET }),
      );
      const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: BUCKET,
            Delete: { Objects: keys },
          }),
        );
      }
      await s3.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    } catch {
      /* best-effort */
    }
    try {
      await dynamo.send(new DeleteTableCommand({ TableName: TABLE }));
    } catch {
      /* best-effort */
    }
    try {
      await prisma?.$disconnect();
      const { Client } = await import("pg");
      const admin = new Client({ connectionString: PG_ADMIN_URL });
      await admin.connect();
      await admin.query(
        `DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`,
      );
      await admin.end();
    } catch {
      /* best-effort */
    }
  }, 60_000);

  it("delete-account worker (REAL composition) soft-deletes the user's media and deletes the staging bytes", async () => {
    // Preconditions: every seeded object really exists as bytes in S3.
    for (const key of [...Object.values(m1Keys), ...Object.values(m2Keys)]) {
      expect(await objectExists(key), `${key} must exist before`).toBe(true);
    }

    const { handler } = await import(
      "../../src/lambda/delete-account-worker.js"
    );
    const result = await handler(
      {
        Records: [
          {
            messageId: "e2e-msg-1",
            body: JSON.stringify({ userId: userAId }),
          },
        ],
      } as never,
      {} as never,
      () => undefined,
    );

    // No partial-batch failure: the deletion must have fully succeeded.
    expect(result).toBeUndefined();

    const db = getTestPrisma();

    // User A is gone; user B untouched.
    expect(await db.user.findUnique({ where: { id: userAId } })).toBeNull();
    expect(
      await db.user.findUnique({ where: { id: userBId } }),
    ).not.toBeNull();

    // M1 (A's own media): soft-deleted into the GC pipeline, personal link
    // scrubbed. THIS is the zero-byte-erasure regression detector on the DB
    // side — if eraseUserMedia stops soft-deleting, deletedAt stays null.
    const m1 = await db.mediaFile.findUnique({ where: { id: m1Id } });
    expect(m1).not.toBeNull();
    expect(m1!.deletedAt).not.toBeNull();
    expect(m1!.uploadedBy).toBeNull();

    // M2 (still referenced by B's post): RETAINED — only the personal link
    // scrubbed. Erasure must never destroy another user's published content.
    const m2 = await db.mediaFile.findUnique({ where: { id: m2Id } });
    expect(m2).not.toBeNull();
    expect(m2!.deletedAt).toBeNull();
    expect(m2!.uploadedBy).toBeNull();

    // Staging bytes for the erased media are GONE from S3 (the GC purge does
    // not cover staging keys — the worker must delete them itself).
    expect(await objectExists(m1Keys.pending)).toBe(false);
    expect(await objectExists(m1Keys.processing)).toBe(false);

    // CAS bytes are still present at this point BY DESIGN: `cas/*` is
    // IAM-immutable to the worker; reclamation happens via the nightly GC
    // purge (next test). Retained media's bytes must also still exist.
    expect(await objectExists(m1Keys.original)).toBe(true);
    expect(await objectExists(m2Keys.original)).toBe(true);
  }, 60_000);

  it("nightly GC purge (REAL handler) reclaims the CAS bytes — zero bytes remain for the erased media", async () => {
    const db = getTestPrisma();

    // The purge window is 7 days; this is an e2e, not a calendar. Backdate
    // the soft-deletion the worker performed so the purge picks it up now.
    await db.mediaFile.update({
      where: { id: m1Id },
      data: { deletedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });

    const { handler } = await import("../../src/lambda/nightly-cron.js");
    await handler({} as never, {} as never, () => undefined);

    // DB row hard-deleted.
    expect(await db.mediaFile.findUnique({ where: { id: m1Id } })).toBeNull();

    // ZERO BYTES REMAIN for the erased media: every S3 object seeded for M1
    // (staging AND cas, original + derivatives) must be gone. If any byte
    // survives, GDPR Art. 17 erasure regressed and this MUST fail.
    for (const [name, key] of Object.entries(m1Keys)) {
      expect(
        await objectExists(key),
        `erased media byte survived: ${name} (${key})`,
      ).toBe(false);
    }

    // The shared media's bytes and row remain intact (B still owns content).
    expect(await objectExists(m2Keys.original)).toBe(true);
    const m2 = await db.mediaFile.findUnique({ where: { id: m2Id } });
    expect(m2).not.toBeNull();
    expect(m2!.deletedAt).toBeNull();
  }, 60_000);
});
