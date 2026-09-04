# Binding presence is not reachability

An engineering note on a defect class this codebase produced repeatedly, what
it looks like, and the rule that replaces it.

## The shape

Nearly every optional infrastructure binding in this codebase is guarded like
this:

```ts
if (env.SOME_KV) {
  // use it
}
// fall through: behave as though the feature is not configured
```

That guard asks **"is the binding present?"** and then acts on the answer to a
different question, **"can I reach the store?"**. On a single-provider platform
the two coincided: no binding meant no backend, and a present binding meant a
working one. They stopped coinciding the moment a deployment could hold a live
client object pointed at a backend it cannot reach.

When that happens the guard **passes**, the "not configured" branch never runs,
and the *call* throws — landing in whatever the surrounding `catch` does. The
surrounding `catch` was almost always written for a transient blip, so it
returns the permissive answer.

## Why it is hard to see

The failure has no signature. No 5xx, no exception reaching a caller, no
alarm — at most a log line on a path nobody watches while the dashboard is
green. And the code reads as careful: it has a guard, a `try`, a log, and an
explicit fallback. Every individual piece looks like defensive programming.

Worse, each instance was **pinned by a passing test**. The suite did not miss
these; it asserted them:

- `"should return 404 on error (getPreferences returns null)"`
- `"should work without EXPORT_JOBS_KV (graceful degradation)"`
- `"should work without EXPORT_QUEUE (development mode)"`
- `"should fail-open when KV throws error"`
- `"tolerates an S3 batch failure and still hard-deletes the DB rows"`

Read those names again. They are not oversights — they are decisions, written
down, with a rationale in the name. Coverage numbers were fine. The only way
these surface is for someone to fix the behaviour and watch a test go red.

## The rule

**Distinguish three states, not two.**

| State | Meaning | Correct response |
|---|---|---|
| **absent** | no binding wired — local dev, a deployment that does not use the feature | the feature is genuinely off; defaults are honest |
| **reachable** | the call succeeded | use the answer |
| **broken** | the binding exists and the call threw | you do **not** know the answer — say so |

The mistake is always the same: collapsing *broken* into *absent*, because both
land on the same fallback. Absent and broken deserve different code paths and
different log levels.

**Then ask what the permissive answer actually asserts.** A fallback is only
safe if it is true. These were not:

| Fallback | What it asserts | Why that is false |
|---|---|---|
| `return { allowed: true }` | "you are under the rate limit" | a limiter that cannot count knows nothing |
| `return null` → `404` | "you have set no privacy preferences" | the user may have set several |
| `return job` (unstored) | "your data export is queued" | nothing was stored or queued |
| skip the block | "the confirmation code checks out" | no code was read |
| hard-delete the row | "the object is gone" | the delete failed |

Every one of those turns "I don't know" into a confident, wrong, *affirmative*
answer. That is the actual bug — not the missing endpoint.

## Applying it

1. **Guard on absence explicitly and early**, before mutating anything. If the
   feature cannot work, refuse before the first write, not after.
2. **Give errors their own branch.** Never share the fallback with absence.
3. **Pick the direction from what the fallback claims**, not from convenience.
   Abuse controls, authorization checks and compliance flows fail closed;
   caches fail to a miss — never to a wrong hit.
4. **Report the truth to the caller.** `503` with `Retry-After` means "ask
   again"; `404` means "there is nothing". Do not use the second for the first.
5. **Undo partial work by hand** when the flow spans two stores. There is no
   transaction across Postgres and a KV store, so a failed second write must
   revert the first or leave the user stranded.
6. **Log absence at `error` in anything that reaches production.** A deployment
   silently running without its abuse control should be loud even though the
   code path is "working as designed".

## Where this is documented per-feature

- [`comment-rate-limiting.md`](comment-rate-limiting.md) — the fail-closed
  policy and its `COMMENT_RATE_LIMIT_FAIL_MODE=open` escape hatch
- [`kv-provider.md`](kv-provider.md) — the two KV ports, and the split-brain
  that a presence guard hid
