/**
 * Unit Tests: `buildEnv()` string-KV provider selection.
 *
 * The defect these pin: the 13 Cloudflare-compat `env.*_KV` bindings were built
 * with an UNCONDITIONAL `new DynamoKv(...)` while the typed `getKvStore()`
 * honoured `KV_PROVIDER`. On a Postgres deployment that is a split-brain — the
 * invitation pre-signup record (typed port) lands in `kv_entries` while the
 * invitation session token (string port) is written to a DynamoDB endpoint that
 * does not resolve.
 *
 * Note what a naive test would NOT catch. Every consumer guards with
 * `if (env.X_KV)`, which tests PRESENCE, not REACHABILITY — and the binding was
 * always present. So "the binding is defined" passes in both the broken and the
 * fixed world; the assertion has to be on the binding's TYPE.
 *
 * No network: `DynamoKv` does not contact DynamoDB until a call, and
 * `makeKvSqlExecutor` builds a lazy `pg.Pool` that does not connect until a
 * query.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DynamoKv } from "@de-otio/saas-foundation/kv";
import { PostgresKv } from "../../src/lib/kv/postgres-kv-namespace.js";

const MANAGED_KEYS = ["SESSION_SECRET", "DATABASE_URL", "KV_PROVIDER"] as const;

/** Every string-KV binding `buildEnv` wires. All 13 must follow the switch. */
const KV_BINDINGS = [
  "RATE_LIMIT_KV",
  "PRIVACY_PREFERENCES_KV",
  "FEED_CACHE_KV",
  "MODERATION_CACHE_KV",
  "COMMENTS_KV",
  "THREAT_INTEL_CACHE_KV",
  "TAXONOMY_CACHE_KV",
  "FOLLOWERS_KV",
  "EXPORT_JOBS_KV",
  "DELETE_JOBS_KV",
  "CSRF_TOKENS_KV",
  "SESSION_BLOCKLIST_KV",
  "INVITATIONS_KV",
] as const;

let savedEnv: Partial<Record<string, string>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_KEYS) savedEnv[key] = process.env[key];
  process.env.SESSION_SECRET = "local-session-secret-minimum-32-chars!!";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/testdb";
  delete process.env.KV_PROVIDER;
});

afterEach(async () => {
  for (const key of MANAGED_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  // buildEnv registers a module-level executor on the postgres path; clear it
  // so a later test's fail-closed assertion is not satisfied by this one's pool.
  const { setKvSqlExecutor } = await import("../../src/lib/kv/kv-provider.js");
  setKvSqlExecutor(undefined);
});

describe("buildEnv — string-KV provider selection", () => {
  it.each(KV_BINDINGS)(
    "wires %s as a PostgresKv when KV_PROVIDER=postgres",
    async (field) => {
      process.env.KV_PROVIDER = "postgres";
      const { buildEnv } = await import("../../src/env.js");
      const env = await buildEnv();

      const binding = (env as unknown as Record<string, unknown>)[field];
      expect(binding).toBeInstanceOf(PostgresKv);
    },
  );

  it.each(KV_BINDINGS)(
    "leaves %s on DynamoKv when KV_PROVIDER is unset (AWS default, zero change)",
    async (field) => {
      const { buildEnv } = await import("../../src/env.js");
      const env = await buildEnv();

      const binding = (env as unknown as Record<string, unknown>)[field];
      expect(binding).toBeInstanceOf(DynamoKv);
    },
  );

  it("leaves the bindings on DynamoKv for an unrecognised KV_PROVIDER", async () => {
    // resolveKvProvider only recognises "postgres"; anything else is DynamoDB.
    // Asserted so a typo'd value cannot silently select a half-configured path.
    process.env.KV_PROVIDER = "postgrez";
    const { buildEnv } = await import("../../src/env.js");
    const env = await buildEnv();

    expect(env.INVITATIONS_KV).toBeInstanceOf(DynamoKv);
  });

  it("binds the string port to a str:-prefixed namespace, disjoint from the typed store", async () => {
    // `invitations` is used by BOTH ports. They store different value shapes,
    // so they must never share (namespace, key) rows in kv_entries.
    process.env.KV_PROVIDER = "postgres";
    const { buildEnv } = await import("../../src/env.js");
    const env = await buildEnv();

    expect((env.INVITATIONS_KV as PostgresKv).boundNamespace).toBe("str:invitations");
  });

  it("gives each binding its own namespace", async () => {
    process.env.KV_PROVIDER = "postgres";
    const { buildEnv } = await import("../../src/env.js");
    const env = await buildEnv();

    const namespaces = KV_BINDINGS.map(
      (f) => ((env as unknown as Record<string, unknown>)[f] as PostgresKv).boundNamespace,
    );
    expect(new Set(namespaces).size).toBe(KV_BINDINGS.length);
  });
});
