// WS5 — EncryptedSettingsHandler: server-blind state-sync boundary.
//
// Owns request-boundary validation (namespace allowlist, size cap, Zod body),
// optimistic-concurrency mapping (CAS -> 200 / 409-with-current), the idle-client
// 304 fast path, and the publish-on-change content-free wakeup.
//
// SERVER-BLIND INVARIANT: the handler treats `ciphertext` as an opaque string.
// It never JSON-parses it, never logs it, and never puts it on the realtime wire
// (the wakeup carries only `version` as the changeToken). The blob travels ONLY
// over the authenticated REST GET. Asserted by the unit tests.

import { z } from "zod";
import type { RealtimeTransport } from "../realtime/types.js";
import { channelFor } from "../realtime/channel.js";
import { encodeWakeup } from "../realtime/types.js";
import { getLogger } from "../logger.js";
import { supportsChangeCursor } from "../realtime/types.js";
import type { SettingsConfig, SettingStore } from "./types.js";
import { BlobTooLargeError, UnknownNamespaceError } from "./types.js";

/** PUT body: opaque ciphertext + the version the client believes it is editing. */
const putBodySchema = z.object({
  ciphertext: z.string(),
  // expectVersion: 0 for a first write, else the version last seen.
  expectVersion: z.number().int().nonnegative(),
});

export type PutBody = z.infer<typeof putBodySchema>;

const JSON_HEADERS = { "content-type": "application/json" } as const;

function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

/**
 * The change-token / ETag for a blob is just its `version` rendered as a string.
 * It leaks only THAT/WHEN a setting changed (version is already plaintext sync
 * metadata per the frozen contract), never WHAT.
 */
function changeTokenFor(version: number): string {
  return String(version);
}

export class EncryptedSettingsHandler {
  constructor(
    private readonly store: SettingStore,
    private readonly config: SettingsConfig,
    private readonly transport?: RealtimeTransport,
  ) {}

  private assertNamespaceAllowed(namespace: string): void {
    if (!this.config.allowedNamespaces.has(namespace)) {
      throw new UnknownNamespaceError(namespace);
    }
  }

  /**
   * GET /api/settings/:namespace. Session-scoped to `userId`.
   *  - unknown namespace -> 404
   *  - matching If-None-Match (the version) -> 304, empty body (idle fast path)
   *  - no blob yet -> 404
   *  - else -> 200 { ciphertext, version, updatedAt } + ETag: <version>
   */
  async handleGet(
    userId: string,
    namespace: string,
    ifNoneMatch: string | null,
  ): Promise<Response> {
    this.assertNamespaceAllowed(namespace);

    const blob = await this.store.get(userId, namespace);
    if (!blob) {
      return json({ error: "NOT_FOUND", message: "No setting blob" }, 404);
    }

    const token = changeTokenFor(blob.version);
    if (ifNoneMatch !== null && ifNoneMatch === token) {
      // Idle-client fast path: nothing changed, return an empty 304.
      return new Response(null, { status: 304, headers: { ETag: token } });
    }

    return json(
      {
        ciphertext: blob.ciphertext,
        version: blob.version,
        updatedAt: blob.updatedAt,
      },
      200,
      { ETag: token },
    );
  }

  /**
   * GET /api/settings/changes?since=<cursor>. Track C — offline backfill.
   * Session-scoped to `userId`. Returns METADATA ONLY for namespaces whose
   * version advanced past the opaque `sinceVersion` cursor — NEVER `ciphertext`.
   * The client re-pulls each changed namespace's blob over the per-namespace GET.
   *
   *  - store lacks the change-cursor capability -> 501 (not configured)
   *  - else -> 200 { changes: [{ namespace, version, updatedAt }, ...], cursor }
   *
   * `cursor` echoes back the new high-watermark (max version seen, or the input
   * `sinceVersion` when nothing changed) so the client can persist it verbatim.
   */
  async handleChanges(
    userId: string,
    sinceVersion: number,
  ): Promise<Response> {
    if (!supportsChangeCursor(this.store)) {
      // The configured store does not implement offline backfill.
      return json(
        {
          error: "NOT_IMPLEMENTED",
          message: "Change cursor is not available on this store",
        },
        501,
      );
    }

    const changes = await this.store.listChangedSince(userId, sinceVersion);
    // New high-watermark: the largest version observed, else the unchanged cursor.
    const cursor = changes.reduce(
      (max, c) => (c.version > max ? c.version : max),
      sinceVersion,
    );
    // METADATA ONLY — `changes` entries are ChangedSettingMeta, which is
    // structurally incapable of carrying ciphertext (asserted by the tests).
    return json({ changes, cursor }, 200);
  }

  /**
   * PUT /api/settings/:namespace. Session-scoped to `userId`; `tenantId` is the
   * server-resolved active tenant (used ONLY to scope the wakeup channel — the
   * blob itself has no tenant).
   *  - unknown namespace -> 404
   *  - invalid body -> 400
   *  - ciphertext over the size cap -> 413, store NEVER called
   *  - CAS conflict -> 409 with the server's current blob (client merges)
   *  - CAS not_found (non-zero expectVersion, no row) -> 409 with null current
   *  - success -> 200 { version, changeToken } + ETag; best-effort wakeup published
   */
  async handlePut(
    userId: string,
    tenantId: string,
    namespace: string,
    body: unknown,
  ): Promise<Response> {
    this.assertNamespaceAllowed(namespace);

    const parsed = putBodySchema.safeParse(body);
    if (!parsed.success) {
      return json(
        { error: "VALIDATION_ERROR", message: "Invalid request body" },
        400,
      );
    }
    const { ciphertext, expectVersion } = parsed.data;

    // Size cap is enforced BEFORE the store is touched.
    const bytes = Buffer.byteLength(ciphertext, "utf8");
    if (bytes > this.config.maxSettingBytes) {
      throw new BlobTooLargeError(bytes, this.config.maxSettingBytes);
    }

    const result = await this.store.put(
      userId,
      namespace,
      // updatedAt is server-assigned by the store; pass a placeholder.
      { ciphertext, version: expectVersion, updatedAt: "" },
      expectVersion,
    );

    if (!result.ok) {
      if (result.reason === "version_conflict") {
        return json(
          {
            error: "VERSION_CONFLICT",
            message: "Stale version; reconcile against current",
            current: {
              ciphertext: result.current.ciphertext,
              version: result.current.version,
              updatedAt: result.current.updatedAt,
            },
          },
          409,
          { ETag: changeTokenFor(result.current.version) },
        );
      }
      // not_found: non-zero expectVersion against an absent row.
      return json(
        {
          error: "NOT_FOUND",
          message: "No setting blob to update at that version",
          current: null,
        },
        409,
      );
    }

    const version = result.stored.version;
    const changeToken = changeTokenFor(version);

    // Publish-on-change: ONE content-free setting_sync wakeup, best-effort. A
    // delivery failure must NOT fail the PUT — REST is the source of truth and
    // the client's next poll converges.
    await this.publishWakeup(userId, tenantId, changeToken);

    return json({ version, changeToken }, 200, { ETag: changeToken });
  }

  /**
   * Best-effort content-free wakeup. Uses encodeWakeup() (the ONLY sanctioned
   * payload builder for setting_sync) with changeToken=version — NEVER the
   * ciphertext. Swallows transport errors; logs at warn.
   */
  private async publishWakeup(
    userId: string,
    tenantId: string,
    changeToken: string,
  ): Promise<void> {
    if (!this.transport) return;
    try {
      const channel = channelFor("setting_sync", { tenantId, userId });
      const payload = encodeWakeup({
        v: 1,
        kind: "setting_sync",
        changeToken,
      });
      await this.transport.deliver({ userId, tenantId }, channel, payload);
    } catch (err) {
      getLogger().warn("setting_sync wakeup publish failed (best-effort)", err);
    }
  }
}
