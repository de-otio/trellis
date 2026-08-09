/**
 * `PostgresKv` — the Postgres adapter for the Cloudflare-compat **string-KV**
 * port (`KVNamespace`), sibling to foundation's `DynamoKv`.
 *
 * ## Why this exists
 *
 * Trellis has TWO KV ports, and until now only one of them could reach
 * Postgres:
 *
 * | Port | Interface | DynamoDB | Postgres |
 * |---|---|---|---|
 * | typed record store | `KvStore` | `DynamoKvStore` | `PostgresKvStore` |
 * | string KV | `KVNamespace` | `DynamoKv` | **this file** |
 *
 * `getKvStore()` honours `KV_PROVIDER`; the 13 `env.*_KV` bindings did not —
 * `buildEnv`'s `kv()` helper constructed a `DynamoKv` unconditionally. On a
 * Postgres deployment that produced a genuine **split-brain**: the invitation
 * pre-signup record went to `kv_entries` while the invitation *session token*
 * went to a DynamoDB endpoint that does not resolve, so half the invitation
 * flow wrote to one backend and the other half threw.
 *
 * The guard that was supposed to catch this is `if (env.X_KV)`, which tests
 * **presence, not reachability**. The binding was present — a live `DynamoKv`
 * object — so the "not configured" branch never fired and the *call* threw
 * instead, straight into whatever the call site did with a caught error.
 *
 * ## Storage layout
 *
 * Shares the `kv_entries` table with `PostgresKvStore` (one table, all
 * namespaces, composite `(namespace, key)` primary key), but under a
 * **`str:`-prefixed namespace** — `str:invitations` vs the typed store's
 * `invitations`. The two ports store different value shapes under the same
 * logical namespace name, and `invitations` is used by both; the prefix makes
 * collision impossible by construction rather than by a convention about key
 * spelling that nothing enforces.
 *
 * `value` is a jsonb envelope, `{ v: <the string>, m: <metadata|null> }`,
 * because `KVNamespace` carries out-of-band metadata (`getWithMetadata`) and
 * the table has no metadata column. `DynamoKv` does the same thing with two
 * attributes.
 *
 * ## Semantics
 *
 * Behaviour matches `DynamoKv` where the two can agree:
 * - `put` is an unconditional upsert; the `version` column is bumped so a row
 *   written through this port is still legible to anything reading versions.
 * - `expiration` (absolute, epoch seconds) wins over `expirationTtl`
 *   (relative), matching `DynamoKv`'s precedence.
 * - `get`/`getWithMetadata`/`list` filter expired rows on read. Postgres has no
 *   native TTL; the WS-1 `kv-entries-cleanup` cron reclaims the space, and
 *   correctness never depends on it having run.
 * - An `ArrayBuffer` value is decoded as UTF-8, as `DynamoKv` does.
 *
 * One deliberate difference: `DynamoKv` signs its list cursors, because a
 * DynamoDB `ExclusiveStartKey` is a full primary key and a forged one could
 * point outside the namespace. Here the cursor is only a `key > $n` bound and
 * the namespace predicate is a separate, non-negotiable parameter, so a forged
 * cursor can at worst skip rows *within the namespace the caller already has*.
 * A malformed cursor restarts from the beginning (safe-fail, same as
 * `DynamoKv`) rather than throwing.
 *
 * ## Injected clock
 *
 * `now?: () => number` (epoch ms, default `Date.now`) — every expiry decision
 * resolves through it and it is bound as a `timestamptz` parameter, never the
 * SQL `now()` function, so expiry is deterministically testable. Same
 * convention as `PostgresKvStore`.
 */

import type {
  KVNamespace,
  KvPutOptions,
  KvListOptions,
  KvListResult,
} from "../../types/cloudflare-compat.js";
import type { SqlExecutor } from "@de-otio/saas-foundation/kv/postgres";

/** Namespace prefix separating string-KV rows from the typed store's rows. */
export const STRING_KV_NAMESPACE_PREFIX = "str:";

/** The jsonb envelope stored in `kv_entries.value`. */
interface StringKvEnvelope {
  readonly v: string;
  readonly m?: Record<string, unknown> | null;
}

export interface PostgresKvOptions {
  /** The logical binding namespace, e.g. `"invitations"` — unprefixed. */
  readonly namespace: string;
  /** Injected clock, epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Default page size when `list` is called without a limit, matching Workers KV. */
const DEFAULT_LIST_LIMIT = 1000;

/**
 * Escape the LIKE metacharacters in a user-supplied prefix. Without this a
 * prefix containing `%` matches far more than the caller asked for — a
 * correctness bug, not an injection one (the value is still parameterized).
 */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/([\\%_])/g, "\\$1");
}

/** Decode a list cursor. Anything unparseable restarts from the beginning. */
function decodeCursor(cursor: string | undefined): string {
  if (cursor === undefined) return "";
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    // A cursor is exactly one key. Reject anything that did not round-trip,
    // which is how a truncated or corrupted base64 string shows up.
    return Buffer.from(decoded, "utf-8").toString("base64") === cursor ? decoded : "";
  } catch {
    return "";
  }
}

function encodeCursor(key: string): string {
  return Buffer.from(key, "utf-8").toString("base64");
}

export class PostgresKv implements KVNamespace {
  private readonly executor: SqlExecutor;
  private readonly namespace: string;
  private readonly now: () => number;

  constructor(executor: SqlExecutor, options: PostgresKvOptions) {
    this.executor = executor;
    this.namespace = `${STRING_KV_NAMESPACE_PREFIX}${options.namespace}`;
    this.now = options.now ?? Date.now;
  }

  /** The prefixed namespace this instance is bound to (diagnostics/tests). */
  get boundNamespace(): string {
    return this.namespace;
  }

  private nowDate(): Date {
    return new Date(this.now());
  }

  /** Absolute expiry as a `timestamptz` bind value, or null for no expiry. */
  private expiryParam(options: KvPutOptions | undefined): Date | null {
    if (options?.expiration !== undefined) {
      return new Date(options.expiration * 1000);
    }
    if (options?.expirationTtl !== undefined) {
      return new Date(this.now() + options.expirationTtl * 1000);
    }
    return null;
  }

  private async read(key: string): Promise<StringKvEnvelope | null> {
    const { rows } = await this.executor.query<{ value: StringKvEnvelope }>(
      `SELECT value FROM kv_entries
        WHERE namespace = $1 AND key = $2
          AND (expires_at IS NULL OR expires_at > $3)`,
      [this.namespace, key, this.nowDate()],
    );
    return rows[0]?.value ?? null;
  }

  async get(key: string, type?: "text"): Promise<string | null>;
  async get<T = unknown>(key: string, type: "json"): Promise<T | null>;
  async get<T = unknown>(key: string, type?: "text" | "json"): Promise<string | T | null> {
    const envelope = await this.read(key);
    if (envelope === null) return null;
    if (type === "json") {
      try {
        return JSON.parse(envelope.v) as T;
      } catch {
        // Same as DynamoKv: an unparseable stored value reads as absent rather
        // than throwing into a caller that asked for JSON.
        return null;
      }
    }
    return envelope.v;
  }

  async getWithMetadata<T>(key: string): Promise<{
    readonly value: string | null;
    readonly metadata: T | null;
  }> {
    const envelope = await this.read(key);
    if (envelope === null) return { value: null, metadata: null };
    return { value: envelope.v, metadata: (envelope.m ?? null) as T | null };
  }

  async put(key: string, value: string | ArrayBuffer, options?: KvPutOptions): Promise<void> {
    const text = typeof value === "string" ? value : Buffer.from(value).toString("utf-8");
    const envelope: StringKvEnvelope = {
      v: text,
      ...(options?.metadata !== undefined ? { m: options.metadata } : {}),
    };

    await this.executor.query(
      `INSERT INTO kv_entries (namespace, key, value, version, expires_at)
            VALUES ($1, $2, $3::jsonb, 1, $4)
       ON CONFLICT (namespace, key) DO UPDATE
              SET value = EXCLUDED.value,
                  version = kv_entries.version + 1,
                  expires_at = EXCLUDED.expires_at`,
      [this.namespace, key, JSON.stringify(envelope), this.expiryParam(options)],
    );
  }

  async delete(key: string): Promise<void> {
    await this.executor.query(`DELETE FROM kv_entries WHERE namespace = $1 AND key = $2`, [
      this.namespace,
      key,
    ]);
  }

  async list(options?: KvListOptions): Promise<KvListResult> {
    const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
    const after = decodeCursor(options?.cursor);
    const prefix = `${escapeLikePrefix(options?.prefix ?? "")}%`;

    // Fetch one extra row: its presence is what distinguishes "this is the last
    // page" from "there is more", without a second COUNT query.
    const { rows } = await this.executor.query<{ key: string; expiration: string | null }>(
      `SELECT key, extract(epoch from expires_at)::bigint AS expiration
         FROM kv_entries
        WHERE namespace = $1
          AND key LIKE $2 ESCAPE '\\'
          AND key > $3
          AND (expires_at IS NULL OR expires_at > $4)
        ORDER BY key
        LIMIT $5`,
      [this.namespace, prefix, after, this.nowDate(), limit + 1],
    );

    const complete = rows.length <= limit;
    const page = complete ? rows : rows.slice(0, limit);
    const keys = page.map((r) =>
      r.expiration === null
        ? { name: r.key }
        : { name: r.key, expiration: Number(r.expiration) },
    );

    return {
      keys,
      list_complete: complete,
      ...(complete ? {} : { cursor: encodeCursor(page[page.length - 1]!.key) }),
    };
  }
}
