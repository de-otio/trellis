# Comment rate limiting

Operational reference for the comment-creation abuse control
(`lib/middleware/comment-rate-limit.ts`).

## What it enforces

Two independent limits, both per user:

| Limit | Default | Env var |
|---|---|---|
| Comments per minute, across all posts | 10 | `COMMENT_RATE_LIMIT_PER_MINUTE` |
| Cooldown between comments on ONE post | 30s | `COMMENT_RATE_LIMIT_POST_COOLDOWN_SECONDS` |

Both are runtime config rather than compiled constants, because the npm tarball
is public and a compiled threshold is a **published** threshold — it tells
anyone who reads it exactly how to pace an abuse campaign to stay under the
ceiling (CLAUDE.md rule 8). Change them per environment; do not hardcode them at
call sites.

Non-positive or non-numeric values fall back to the default. A ceiling of `0`
is therefore *not* a way to block all commenting — it resolves to 10.

## Failure policy — read this before debugging a 429 spike

| Situation | Behaviour | Log |
|---|---|---|
| `RATE_LIMIT_KV` **absent** | allow | `error` — "not configured - rate limiting disabled" |
| Store call **throws** | **deny** (default) | `error` — "denying request (fail-closed)" |
| Store call throws, `COMMENT_RATE_LIMIT_FAIL_MODE=open` | allow | `error` — "…(COMMENT_RATE_LIMIT_FAIL_MODE=open)" |

**A store outage now produces 429s on comment creation.** That is deliberate,
and it is a change: this path used to return `{ allowed: true }` on any error.

The reasoning is that "fail open on error" is defensible when the store fails
*occasionally* and the alternative is blocking real users. It is indefensible
when the store fails *always* — which is what a half-migrated platform produces.
The binding gets constructed against a host that does not resolve, every call
throws, and comment rate limiting is not degraded but **entirely absent**,
silently: no 5xx, no throw reaching a caller, nothing but a log line on a path
nobody watches while it is green.

An abuse control that cannot count has no basis for saying yes. The cost of
denying is a retryable 429 on one comment; the cost of allowing is an unbounded,
unmetered comment flood.

### If you need the endpoint more than the control

Set `COMMENT_RATE_LIMIT_FAIL_MODE=open`. Only the exact string `open` is
honoured — unset, empty, misspelt, and `OPEN` all resolve to `closed`, so a
typo cannot silently disable the control.

Prefer fixing the store. `fail_mode=open` restores exactly the state this
change was made to remove.

### Absence vs. unreachability

The guard for "no store" is `if (!kv)`, which tests **presence, not
reachability**. On a fully-AWS platform those were the same question. They are
not on a half-migrated one: the binding *is* present (a live client object), so
the "not configured" branch never fires and the call throws into the error path
instead. That distinction is why absence and failure now get different
treatment, and it is worth checking wherever else this codebase writes
`if (env.X)`.

## Diagnosing

- 429s with `retryAfter: 30` and no per-user/per-post limit log line → the
  fail-closed path. Look for "denying request (fail-closed)" and fix the store.
- No rate limiting at all, no errors → `RATE_LIMIT_KV` is absent. Look for
  "not configured - rate limiting disabled" at startup traffic.
- Limits behaving unexpectedly → check the env vars above resolved as intended;
  `resolveCommentRateLimitEnv` in `env.ts` is their only reader.

## Known limitation

The per-user window is a read-modify-write over KV (`get` then `put`), not an
atomic counter, so concurrent requests can read the same count and each be
allowed. The token-bucket limiter in `lib/rate-limit.ts` does not have this
problem; consolidating this path onto it would fix the race and remove the
second, bespoke KV access pattern.
