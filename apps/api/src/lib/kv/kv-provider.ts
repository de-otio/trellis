/**
 * Central `KvStore` provider selection for the WS-1 typed-store hot-spot
 * namespaces (ws1-kv-port-plan §5).
 *
 * `KV_PROVIDER` (env, default `"dynamodb"`) selects the backend:
 *   - unset / "dynamodb" → `DynamoKvStore` over the byte-compat §4.1 layout for
 *     each namespace. **Existing AWS deployments set nothing and see ZERO
 *     change** — same table, pk/sk/ttl attrs; only the additive `_v`.
 *   - "postgres" → `PostgresKvStore` over the shared KV pool (a small dedicated
 *     `pg.Pool`, NOT the tenant-scoped Prisma pool — KV is global). The executor
 *     is wired once in `buildEnv`; a fail-closed guard throws if it is missing.
 *
 * This factory covers the SINGLE-store namespaces. The two-row modules
 * (refresh-detection `j#`/`s#`, device-auth `dc#`/`uc#`) and the server-built
 * `job` lock construct their own DynamoKvStore today; their Postgres wiring is a
 * documented follow-up and does not affect the default (DynamoDB) path.
 *
 * Every module keeps its `__set…StoreForTest` seam, which short-circuits this
 * factory in unit tests (they inject a `MemoryKvStore`), so `KV_PROVIDER` only
 * takes effect at runtime.
 */

import {
  DynamoKvStore,
  createDefaultDynamoClient,
  type DynamoKvLayout,
  type KvStore,
} from "@de-otio/saas-foundation/kv";
import { PostgresKvStore, type SqlExecutor } from "@de-otio/saas-foundation/kv/postgres";

export type KvProvider = "dynamodb" | "postgres";

/** The single-store namespaces this factory resolves. */
export type SingleKvNamespace =
  | "costtrack"
  | "costbudget"
  | "discexposure"
  | "invitations"
  | "claims"
  | "idem";

export function resolveKvProvider(): KvProvider {
  return process.env.KV_PROVIDER === "postgres" ? "postgres" : "dynamodb";
}

/** Per-namespace byte-compat DynamoDB layout (minus the resolved `tableName`). */
type LayoutSpec = Omit<DynamoKvLayout, "tableName">;

const LAYOUTS: Record<SingleKvNamespace, LayoutSpec> = {
  costtrack: {
    pkPrefix: "costtrack",
    pkSeparator: ":",
    skName: "sk",
    skValue: "v",
    ttlAttr: "ttl",
    versionAttr: "_v",
    nativeNumberFields: ["units"],
    allowSeparatorInKey: true,
  },
  costbudget: {
    pkPrefix: "costbudget",
    pkSeparator: ":",
    skName: "sk",
    skValue: "v",
    ttlAttr: "ttl",
    versionAttr: "_v",
    nativeNumberFields: ["count"],
    allowSeparatorInKey: true,
  },
  discexposure: {
    pkPrefix: "discexposure",
    pkSeparator: ":",
    skName: "sk",
    skValue: "v",
    ttlAttr: "ttl",
    versionAttr: "_v",
    nativeNumberFields: ["count"],
    allowSeparatorInKey: true,
  },
  invitations: {
    pkPrefix: "invitations",
    pkSeparator: ":",
    skName: "sk",
    skValue: "v",
    ttlAttr: "ttl",
    versionAttr: "_v",
  },
  claims: {
    pkPrefix: "claims",
    pkSeparator: ":",
    skName: "sk",
    skValue: "meta",
    ttlAttr: "ttl",
    versionAttr: "_v",
  },
  idem: {
    // pk-only (no sk); TTL attr is `expiresAt`. The composite key contains `#`.
    pkPrefix: "idem",
    pkSeparator: "#",
    ttlAttr: "expiresAt",
    versionAttr: "_v",
    allowSeparatorInKey: true,
  },
};

function stage(): string {
  return process.env.STAGE || "dev";
}

function tableFor(namespace: SingleKvNamespace): string {
  if (namespace === "idem") {
    return process.env.IDEMPOTENCY_TABLE || `${stage()}-trellis-idempotency`;
  }
  return process.env.DYNAMODB_TABLE || `${stage()}-trellis`;
}

// The shared KV SQL executor (a small dedicated pg pool), wired once by buildEnv
// when KV_PROVIDER=postgres. Kept module-local so the per-namespace factory can
// build PostgresKvStore instances without re-opening a pool per instance.
let _kvSqlExecutor: SqlExecutor | undefined;

/** Register the shared KV SQL executor (buildEnv, postgres path only). */
export function setKvSqlExecutor(executor: SqlExecutor | undefined): void {
  _kvSqlExecutor = executor;
}

/** The shared KV SQL executor, or undefined if the postgres path is not wired. */
export function getKvSqlExecutor(): SqlExecutor | undefined {
  return _kvSqlExecutor;
}

/**
 * Build the shared KV SQL executor — a small dedicated `pg.Pool` (KV is GLOBAL,
 * not tenant-scoped, so it must bypass the tenant-scoping Prisma extension).
 * `pg` is imported dynamically so the DynamoDB (default) path never loads it.
 * Called once by `buildEnv` when `KV_PROVIDER=postgres`.
 */
export async function makeKvSqlExecutor(connectionString: string): Promise<SqlExecutor> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, max: 4 });
  return {
    query: <R = Record<string, unknown>>(text: string, params: readonly unknown[]) =>
      pool.query(text, params as unknown[]) as unknown as Promise<{ rows: R[] }>,
  };
}

/**
 * Resolve the `KvStore` for a single-store namespace, honoring `KV_PROVIDER`.
 * Default path builds a byte-compat DynamoKvStore (zero AWS change).
 */
export function getKvStore(namespace: SingleKvNamespace): KvStore {
  if (resolveKvProvider() === "postgres") {
    if (_kvSqlExecutor === undefined) {
      // Fail closed: a postgres deployment must have wired the executor.
      throw new Error(
        `KV_PROVIDER=postgres but the KV SQL executor is not wired (buildEnv) for namespace=${namespace}`,
      );
    }
    return new PostgresKvStore(_kvSqlExecutor, { namespace });
  }
  return new DynamoKvStore(createDefaultDynamoClient(), {
    tableName: tableFor(namespace),
    ...LAYOUTS[namespace],
  });
}
