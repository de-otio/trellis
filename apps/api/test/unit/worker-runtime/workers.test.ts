/**
 * T7a — dispatch-table gates: the finding-4 media secret-isolation guard and
 * the §3.3 disposition mapping from the extracted cores' outcome enums.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDispatchTable,
  FORBIDDEN_MEDIA_CAPABILITY_KEYS,
  type DispatchTableInput,
} from "../../../../worker/src/workers.js";
import {
  setMediaProcessingDeps,
  __resetMediaProcessingDeps,
  type MediaProcessingDeps,
} from "../../../src/lib/workers/media-processing.js";
import type { CompletionDeps } from "../../../src/lib/workers/media-completion.js";
import type { ReceivedMessage } from "../../../../worker/src/dispatch.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

function baseInput(overrides: Partial<DispatchTableInput> = {}): DispatchTableInput {
  return {
    logger: makeLogger(),
    deleteAccount: {
      getDb: vi.fn(async () => ({ user: { findUnique: vi.fn().mockResolvedValue(null) } }) as never),
      resolvePseudonymSecret: vi.fn(async () => "secret"),
      deleteStagingObjects: vi.fn(async () => ({ requested: 0, failedBatches: 0, truncated: false })),
    },
    media: {},
    federationEnabled: false,
    ...overrides,
  };
}

function raw(body: string): ReceivedMessage {
  return { messageId: "m-1", receiptHandle: "rh-1", body };
}

afterEach(() => {
  __resetMediaProcessingDeps();
});

describe("buildDispatchTable", () => {
  it("GATE (finding 4): refuses a media bag carrying GDPR/identity/session capabilities", () => {
    for (const key of FORBIDDEN_MEDIA_CAPABILITY_KEYS) {
      expect(() =>
        buildDispatchTable(
          baseInput({ media: { [key]: () => "leak" } as never }),
        ),
      ).toThrow(/finding 4/);
    }
  });

  it("the delete-account bag is the only place GDPR capabilities live, as LAZY providers", async () => {
    const input = baseInput();
    const table = buildDispatchTable(input);
    // Building the table resolves NOTHING (lazy at-use).
    expect(input.deleteAccount.resolvePseudonymSecret).not.toHaveBeenCalled();
    // User-not-found path: worker resolves the secret at USE, then acks.
    await table["delete-account"]({ userId: "gone" }, raw("{}"));
    expect(input.deleteAccount.resolvePseudonymSecret).toHaveBeenCalledTimes(1);
  });

  describe("media-processing mapping (§3.3)", () => {
    it("fails closed (throws → no-ack) when deps were never injected", async () => {
      const table = buildDispatchTable(baseInput());
      await expect(
        table["media-processing"]({}, raw(JSON.stringify({ objectKey: "pending/t/u" }))),
      ).rejects.toThrow(/deps not injected/);
    });

    it("poison (unparseable body) surfaces as a RETURNED ack-drop, not a throw", async () => {
      // processRecord only touches deps.logger on this path.
      setMediaProcessingDeps({ logger: makeLogger() } as unknown as MediaProcessingDeps);
      const table = buildDispatchTable(baseInput());
      const d = await table["media-processing"]({}, raw("not json"));
      expect(d).toBe("ack-drop");
    });

    it("a clean non-pending-key drop is a plain ack", async () => {
      setMediaProcessingDeps({ logger: makeLogger() } as unknown as MediaProcessingDeps);
      const table = buildDispatchTable(baseInput());
      // Valid JSON, native shape, but not a pending/ key → ack (not our work).
      const d = await table["media-processing"](
        {},
        raw(JSON.stringify({ objectKey: "cas/nope/xyz" })),
      );
      expect(d).toBe("ack");
    });
  });

  describe("media-completion mapping (§3.3)", () => {
    it("fails closed (throws → no-ack) when completion deps are absent", async () => {
      const table = buildDispatchTable(baseInput());
      await expect(
        table["media-completion"]({}, raw(JSON.stringify({ JobId: "j1" }))),
      ).rejects.toThrow(/deps not injected/);
    });

    it("an unroutable pointer is a RETURNED ack-drop (no DLQ loop)", async () => {
      const table = buildDispatchTable(
        baseInput({
          media: { completionDeps: { log: {} } as unknown as CompletionDeps },
        }),
      );
      const d = await table["media-completion"]({}, raw(JSON.stringify({ nothing: true })));
      expect(d).toBe("ack-drop");
    });
  });

  it("stub workers throw through the table (→ dispatcher fail)", async () => {
    const table = buildDispatchTable(baseInput());
    await expect(table["link-check"]({}, raw("{}"))).rejects.toThrow(/failing closed/);
    await expect(table["followers-events"]({}, raw("{}"))).rejects.toThrow(/failing closed/);
  });

  it("federation-outbox: OFF returns (ack), ON throws (fail)", async () => {
    const off = buildDispatchTable(baseInput({ federationEnabled: false }));
    await expect(off["federation-outbox"]({}, raw("{}"))).resolves.toBeUndefined();

    const on = buildDispatchTable(baseInput({ federationEnabled: true }));
    await expect(on["federation-outbox"]({}, raw("{}"))).rejects.toThrow(/failing closed/);
  });
});

describe("user-export boundary (T11, finding 9)", () => {
  it("fails closed (throws → no-ack) when no ExportWorkerPort is injected — DSARs are never dropped", async () => {
    const table = buildDispatchTable(baseInput());
    await expect(
      table["user-export"](
        { jobId: "j1", userId: "u1", email: "u@example.com", format: "json", region: "EU" },
        raw("{}"),
      ),
    ).rejects.toThrow(/not injected/);
  });

  it("maps the port's results onto dispositions: completed→ack, failed→ack-drop, retry→fail", async () => {
    const results = [
      { kind: "completed" as const },
      { kind: "failed" as const, reason: "user gone" },
      { kind: "retry" as const, reason: "storage blip" },
    ];
    let i = 0;
    const table = buildDispatchTable(
      baseInput({ exportWorker: { run: async () => results[i++] } }),
    );
    const msg = { jobId: "j1", userId: "u1", email: "u@example.com", format: "json", region: "EU" };
    expect(await table["user-export"](msg, raw("{}"))).toBe("ack");
    expect(await table["user-export"](msg, raw("{}"))).toBe("ack-drop");
    expect(await table["user-export"](msg, raw("{}"))).toBe("fail");
  });

  it("GATE (finding 9): the public port file discloses NO table/column/field-level PII schema", () => {
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../src/lib/workers/export-worker-port.ts",
      ),
      "utf-8",
    );
    // The port carries only the job pointer + routing; a schema disclosure
    // would name Prisma models/columns. Guard against the obvious markers.
    for (const marker of [
      "prisma",
      "findMany",
      "select:",
      "posts",
      "comments",
      "directMessage",
      "securityEvent",
      "mediaFile",
      "interactionEvent",
      "consent",
      "invitation",
    ]) {
      expect(src.toLowerCase()).not.toContain(marker.toLowerCase());
    }
  });
});
