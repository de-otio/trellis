/**
 * Automated reviewer on the moderator path.
 *
 * An automated actor may only CLEAR an item held in REVIEW, through the same
 * audited, version-pinned promotion a human approval uses. It can never reject,
 * and it can never act on QUARANTINED or any other state.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

import {
  MediaReviewHandler,
  type ReviewActor,
  type ReviewPrismaLike,
  type ReviewPromotionPort,
} from "../../../src/lib/media/media-review-handler.js";
import { MockStoragePort } from "../../../src/lib/media/media-ports.js";
import type {
  TrellisAuditLogger,
  TrellisAuditLoggerEnv,
} from "../../../src/lib/audit-composer.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const TENANT = "c0000000000000000000000aa";
const UPLOAD = "c1111111111111111111111bb";
const HASH = "a".repeat(64);
const CAS_KEY = `cas/${TENANT}/${HASH}`;
const STAGING_KEY = `processing/${TENANT}/${UPLOAD}`;
const PENDING_KEY = `pending/${TENANT}/${UPLOAD}`;
const MEDIA_ID = "media-1";

const AUTOMATED: Extract<ReviewActor, { kind: "automated" }> = {
  kind: "automated",
  reviewerId: "reviewer-1",
  modelId: "model-x@1",
};

function row(lifecycle: string): Record<string, unknown> {
  return {
    id: MEDIA_ID,
    tenantId: TENANT,
    lifecycle,
    originalKey: CAS_KEY,
    deletedAt: null,
  };
}

/**
 * `updateMany` models a compare-and-set: it applies only while the stored
 * lifecycle still equals `where.lifecycle`. `raceTo` simulates another writer
 * changing the row between the handler's read and its write.
 */
function makeDb(initial: string, opts: { raceTo?: string } = {}) {
  const state = { lifecycle: initial };
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  let raced = false;
  const db: ReviewPrismaLike = {
    mediaFile: {
      findMany: async () => [],
      findUnique: async () => row(state.lifecycle),
      update: async (args) => {
        const a = args as { data: { lifecycle?: string } };
        if (a.data.lifecycle) state.lifecycle = a.data.lifecycle;
        return row(state.lifecycle);
      },
      updateMany: async (args) => {
        const a = args as {
          where: { lifecycle: string };
          data: { lifecycle: string };
        };
        writes.push(a as never);
        if (opts.raceTo && !raced) {
          raced = true;
          state.lifecycle = opts.raceTo;
        }
        if (state.lifecycle !== a.where.lifecycle) return { count: 0 };
        state.lifecycle = a.data.lifecycle;
        return { count: 1 };
      },
    },
    user: { findUnique: vi.fn(async () => ({ role: "END_USER" })) },
  };
  return { db, state, writes };
}

function makeAudit() {
  const logSystemAction = vi.fn(async () => undefined);
  return {
    logger: { logSystemAction } as unknown as TrellisAuditLogger,
    logSystemAction,
  };
}

async function world(): Promise<{
  storage: MockStoragePort;
  port: ReviewPromotionPort;
  coordsFor: ReturnType<typeof vi.fn>;
}> {
  const storage = new MockStoragePort();
  await storage.putObject(STAGING_KEY, Buffer.from("reviewed"), "video/mp4");
  await storage.putObject(PENDING_KEY, Buffer.from("raw"), "video/mp4");
  const coordsFor = vi.fn(async () => ({
    tenantId: TENANT,
    uploadId: UPLOAD,
    contentHash: HASH,
    stagingVersionId: "mock-version-1",
  }));
  return { storage, coordsFor, port: { storage, coordsFor } };
}

const env = {} as TrellisAuditLoggerEnv;
const input = {
  mediaId: MEDIA_ID,
  actor: AUTOMATED,
  decision: "approve" as const,
  region: "eu" as never,
};

describe("MediaReviewHandler.decide — automated actor", () => {
  it("approves an item held in REVIEW, promotes it, and records the actor", async () => {
    const { db, state } = makeDb("REVIEW");
    const { logger, logSystemAction } = makeAudit();
    const { storage, port } = await world();

    const result = await new MediaReviewHandler().decide(db, logger, env, input, port);

    expect(result).toEqual({ ok: true, status: "APPROVED", promoted: true });
    expect(state.lifecycle).toBe("APPROVED");
    expect(await storage.getObject(CAS_KEY)).toBeTruthy();

    expect(logSystemAction).toHaveBeenCalledTimes(1);
    const [action, event] = logSystemAction.mock.calls[0] as unknown as [
      string,
      { metadata: Record<string, unknown> },
    ];
    expect(action).toBe("media.moderation.approved");
    expect(event.metadata).toMatchObject({
      actorKind: "automated",
      reviewerId: "reviewer-1",
      modelId: "model-x@1",
      fromLifecycle: "REVIEW",
      toLifecycle: "APPROVED",
      promoted: true,
    });
  });

  it("does not consult the User table: the caller is server-side code, not a session", async () => {
    const { db } = makeDb("REVIEW");
    const { logger } = makeAudit();
    const { port } = await world();
    await new MediaReviewHandler().decide(db, logger, env, input, port);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("refuses QUARANTINED: illegal, unchanged, nothing promoted or audited", async () => {
    const { db, state, writes } = makeDb("QUARANTINED");
    const { logger, logSystemAction } = makeAudit();
    const { storage, port, coordsFor } = await world();

    const result = await new MediaReviewHandler().decide(db, logger, env, input, port);

    expect(result).toEqual({ ok: false, code: "ILLEGAL_STATE", from: "QUARANTINED" });
    expect(state.lifecycle).toBe("QUARANTINED");
    expect(writes).toHaveLength(0);
    expect(coordsFor).not.toHaveBeenCalled();
    expect(logSystemAction).not.toHaveBeenCalled();
    expect(await storage.getObject(CAS_KEY).catch(() => null)).toBeFalsy();
  });

  it.each(["AWAITING_UPLOAD", "UPLOADED", "APPROVED", "REJECTED", "UPLOAD_FAILED"])(
    "refuses %s",
    async (from) => {
      const { db, state } = makeDb(from);
      const { logger } = makeAudit();
      const { port, coordsFor } = await world();
      const result = await new MediaReviewHandler().decide(db, logger, env, input, port);
      expect(result).toEqual({ ok: false, code: "ILLEGAL_STATE", from });
      expect(state.lifecycle).toBe(from);
      expect(coordsFor).not.toHaveBeenCalled();
    },
  );

  it("is a compare-and-set from REVIEW: a state change between read and write is illegal, with no promotion", async () => {
    const { db, state, writes } = makeDb("REVIEW", { raceTo: "REJECTED" });
    const { logger, logSystemAction } = makeAudit();
    const { port, coordsFor } = await world();

    const result = await new MediaReviewHandler().decide(db, logger, env, input, port);

    expect(result).toMatchObject({ ok: false, code: "ILLEGAL_STATE" });
    expect(writes[0].where).toMatchObject({ id: MEDIA_ID, lifecycle: "REVIEW" });
    expect(state.lifecycle).toBe("REJECTED");
    expect(coordsFor).not.toHaveBeenCalled();
    expect(logSystemAction).not.toHaveBeenCalled();
  });

  it("holds REVIEW when promotion fails", async () => {
    const { db, state } = makeDb("REVIEW");
    const { logger } = makeAudit();
    const { storage, coordsFor } = await world();
    coordsFor.mockResolvedValueOnce(null as never);

    const result = await new MediaReviewHandler().decide(db, logger, env, input, {
      storage,
      coordsFor,
    });

    expect(result).toEqual({ ok: true, status: "REVIEW", promoted: false });
    expect(state.lifecycle).toBe("REVIEW");
  });

  it("never rejects, even if the type is bypassed: a forged reject is illegal and changes nothing", async () => {
    const { db, state, writes } = makeDb("REVIEW");
    const { logger, logSystemAction } = makeAudit();
    const { storage, port, coordsFor } = await world();

    const result = await new MediaReviewHandler().decide(
      db,
      logger,
      env,
      { ...input, decision: "reject" } as never,
      port,
    );

    expect(result).toEqual({ ok: false, code: "ILLEGAL_STATE", from: "REVIEW" });
    expect(state.lifecycle).toBe("REVIEW");
    expect(writes).toHaveLength(0);
    expect(coordsFor).not.toHaveBeenCalled();
    expect(logSystemAction).not.toHaveBeenCalled();
    expect(await storage.getObject(CAS_KEY).catch(() => null)).toBeFalsy();
  });

  it("refuses an unrecognised actor kind rather than treating it as a human", async () => {
    const { db, state, writes } = makeDb("REVIEW");
    const { logger, logSystemAction } = makeAudit();
    const { port } = await world();

    await expect(
      new MediaReviewHandler().decide(
        db,
        logger,
        env,
        { ...input, actor: { kind: "service" } } as never,
        port,
      ),
    ).rejects.toThrow(TypeError);

    expect(state.lifecycle).toBe("REVIEW");
    expect(writes).toHaveLength(0);
    expect(logSystemAction).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for a missing or deleted item", async () => {
    const { db } = makeDb("REVIEW");
    (db.mediaFile.findUnique as unknown) = async () => null;
    const { logger } = makeAudit();
    const result = await new MediaReviewHandler().decide(db, logger, env, input);
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("MediaReviewHandler.decide — an automated actor can only approve (compile-time)", () => {
  // `apps/api/test` is not covered by `tsc --build`, so a bare
  // `// @ts-expect-error` in a test would be vacuous: nothing would ever check
  // it. Instead run the real compiler over a probe file with one call per line
  // and assert which lines are diagnosed.
  const srcDir = path.resolve(here, "../../../src");
  const apiDir = path.resolve(here, "../../..");

  const automated = `{ kind: "automated" as const, reviewerId: "r", modelId: "m" }`;
  const human = `{ kind: "human" as const, userId: "u" }`;
  const call = (actor: string, decision: string) =>
    `export const probe${decision}${actor === automated ? "A" : "H"} = () => handler.decide(db, audit, env, { mediaId: "m", actor: ${actor}, decision: "${decision}", region });`;

  const probes = {
    automatedReject: call(automated, "reject"),
    automatedApprove: call(automated, "approve"),
    humanReject: call(human, "reject"),
    humanApprove: call(human, "approve"),
  } as const;

  function diagnosedProbes(): Set<keyof typeof probes> {
    const dir = mkdtempSync(path.join(tmpdir(), "decide-type-probe-"));
    try {
      const file = path.join(dir, "probe.ts");
      const header = [
        `import { MediaReviewHandler, type ReviewPrismaLike } from ${JSON.stringify(path.join(srcDir, "lib/media/media-review-handler.js"))};`,
        `import type { TrellisAuditLogger, TrellisAuditLoggerEnv } from ${JSON.stringify(path.join(srcDir, "lib/audit-composer.js"))};`,
        `declare const handler: MediaReviewHandler;`,
        `declare const db: ReviewPrismaLike;`,
        `declare const audit: TrellisAuditLogger;`,
        `declare const env: TrellisAuditLoggerEnv;`,
        `declare const region: never;`,
      ];
      const names = Object.keys(probes) as Array<keyof typeof probes>;
      writeFileSync(file, [...header, ...names.map((n) => probes[n])].join("\n"));
      const tsc = path.resolve(apiDir, "../../node_modules/.bin/tsc");
      const out = spawnSync(
        tsc,
        [
          "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck",
          "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext",
          "--types", "node", "--typeRoots", path.resolve(apiDir, "../../node_modules/@types"),
          file,
        ],
        { cwd: apiDir, encoding: "utf8" },
      );
      const diagnosed = new Set<keyof typeof probes>();
      for (const m of `${out.stdout}${out.stderr}`.matchAll(/probe\.ts\((\d+),\d+\): error/g)) {
        const name = names[Number(m[1]) - 1 - header.length];
        if (name) diagnosed.add(name);
      }
      // Every diagnostic must be attributable to a probe line: an error in the
      // header or in src would otherwise make this test pass for the wrong reason.
      const total = [...`${out.stdout}${out.stderr}`.matchAll(/error TS\d+/g)].length;
      expect(total).toBe(
        [...`${out.stdout}${out.stderr}`.matchAll(/probe\.ts\((\d+),\d+\): error/g)].length,
      );
      return diagnosed;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("rejects { actor: automated, decision: 'reject' } and nothing else", () => {
    expect([...diagnosedProbes()]).toEqual(["automatedReject"]);
  }, 120_000);
});
