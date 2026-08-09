# KV provider selection (`KV_PROVIDER`)

Operator reference for the two key-value ports and the single switch that
selects their backend.

## The two ports

Trellis has two KV abstractions, deliberately kept separate. Both now follow
the same switch; until this was fixed only one of them did.

| Port | Interface | Used for | DynamoDB | Postgres |
|---|---|---|---|---|
| typed record store | `KvStore` | atomic primitives — `putIfAbsent`, `compareAndSet`, `increment`, version-guarded `delete`, one secondary index | `DynamoKvStore` | `PostgresKvStore` |
| string KV | `KVNamespace` | plain `get`/`put`/`delete` on string values | `DynamoKv` | `PostgresKv` |

The typed port is reached through `getKvStore(namespace)`
(`lib/kv/kv-provider.ts`). The string port is the 13 `env.*_KV` bindings wired
in `buildEnv`: `RATE_LIMIT_KV`, `PRIVACY_PREFERENCES_KV`, `FEED_CACHE_KV`,
`MODERATION_CACHE_KV`, `COMMENTS_KV`, `THREAT_INTEL_CACHE_KV`,
`TAXONOMY_CACHE_KV`, `FOLLOWERS_KV`, `EXPORT_JOBS_KV`, `DELETE_JOBS_KV`,
`CSRF_TOKENS_KV`, `SESSION_BLOCKLIST_KV`, `INVITATIONS_KV`.

## The switch

| `KV_PROVIDER` | Backend | Notes |
|---|---|---|
| unset (default) | DynamoDB | AWS deployments set nothing and see zero change |
| `dynamodb` | DynamoDB | explicit form of the default |
| `postgres` | Postgres `kv_entries` | requires a resolvable `DATABASE_URL` |

Only the exact string `postgres` selects Postgres. Anything else — a typo, a
misspelling, `POSTGRES` — resolves to DynamoDB, so a bad value cannot leave the
deployment on a half-configured path.

On the Postgres path `buildEnv` opens a **small dedicated `pg.Pool`** (max 4)
rather than reusing the Prisma client. KV is global, not tenant-scoped, so it
must bypass the tenant-scoping Prisma extension.

## Why both ports must agree — the split-brain

Before this fix, `getKvStore()` honoured `KV_PROVIDER` and the 13 string
bindings did not: `buildEnv`'s `kv()` helper constructed a `DynamoKv`
unconditionally.

On a Postgres deployment that split the invitation flow in half. The
pre-signup record (typed port) was written to `kv_entries`, while the
invitation **session token** (string port) was written to a DynamoDB endpoint
that does not resolve — so creating an invitation threw, and validating one
failed closed. Same feature, same logical namespace, two backends.

Nothing caught it, because every consumer guards with `if (env.X_KV)` — a test
of **presence, not reachability**. The binding was present: a live `DynamoKv`
object. The "not configured" branch never fired; the *call* threw instead, into
whatever each call site did with a caught error. Worth checking wherever else
this codebase writes `if (env.X)`.

## Storage layout on Postgres

Both ports share the `kv_entries` table — one table, all namespaces, composite
`(namespace, key)` primary key.

The string port binds to a **`str:`-prefixed namespace**: `str:invitations`
versus the typed store's `invitations`. `invitations` is the one namespace both
ports use, and they store different value shapes, so the prefix makes collision
impossible by construction rather than by a convention about key spelling that
nothing enforces.

String values are stored in a jsonb envelope, `{ v: <string>, m: <metadata> }`,
because `KVNamespace` carries out-of-band metadata (`getWithMetadata`) and the
table has no metadata column. `DynamoKv` does the same with two attributes.

## Expiry

Postgres has no native TTL. Every read (`get`, `getWithMetadata`, `list`)
carries an `expires_at IS NULL OR expires_at > $now` predicate, so an expired
row is invisible whether or not anything has swept it — correctness never
depends on the sweep.

Space is reclaimed by the worker's **`kv-entries-cleanup`** cron, registered on
the Scaleway profile only (`apps/worker/src/cron-jobs.ts`). It skips rows with
`expires_at IS NULL`, so the durable no-TTL namespaces are never swept. The
sweep is namespace-agnostic and covers `str:` rows as well.

## Diagnosing

- **Boot fails with "KV_PROVIDER=postgres but the KV SQL executor is not
  wired"** — the provider block in `buildEnv` did not run before a binding was
  constructed. This is fail-closed on purpose: serving with a silently absent
  KV would disable the invitation gate, CSRF-token validation and the session
  blocklist.
- **`ENOTFOUND`/timeout from a KV call on a non-AWS deployment** — a binding is
  still on DynamoDB. Confirm `KV_PROVIDER=postgres` is actually set in the
  running pod, not only in the manifest.
- **A feature half-works** (writes land, reads miss, or vice versa) — check
  whether the two sides use different ports. `getKvStore(...)` and `env.*_KV`
  are separate namespaces even when the name matches.
- **Rows accumulating in `kv_entries`** — expired rows linger by design until
  the cleanup cron runs; confirm the worker is on the Scaleway profile.
