# Test Strategy — Implementation Plan

Work breakdown and sequencing to realize the testing strategy. Companion to
[strategy.md](strategy.md) (what to test) and [standalone.md](standalone.md)
(the independence design) — this doc covers **when and in what order**.

> **Perspective.** Every stage here is **Trellis-core** work that runs in this
> repo with `docker-compose up` and no AWS account. The goal is to shrink the
> set of things that can only be verified in the consuming vertical's deployed
> environment down to the irreducible minimum (real Cognito triggers, ECS
> pool behaviour, the CloudFront edge path — see Stage 6).

> **Progress (Stages 0–2 + 4 landed).** The dummy target + standalone lane
> exist and are green (`npm run test:standalone`), wired into CI as a
> `standalone` job, with `smoke-pack.sh` asserting fixtures never ship. The
> extension-API **contract tests** (Stage 4) also landed
> (`test/unit/extension-contract.test.ts` + `public-api.test.ts`, 17 tests, no
> infra): `validateExtensions` accept/reject cases, the metadataSchema
> contract, optional surfaces, hooks/lifecycle, and a public-export snapshot —
> all in the existing `npm test` lane. Building the lane surfaced three real
> bugs (all in Trellis, not the foundation packages): a hardcoded SSL pool
> option that broke any local Postgres; a Neo4j-driver-per-request leak across
> ~10 handlers (now memoized to a shared, closeable singleton); and
> `EntityHandler.createEntityProfile` not stamping the required `tenantId` after
> the v0.7 tenancy migration (the entity happy-path create is `skip`ped pending
> identity-federation Stage 3). See [standalone.md](standalone.md) for the
> per-finding detail.
>
> **Remaining:** Stage 6 (the consumer-only residual) is now documented in
> [standalone.md](standalone.md#the-consumer-only-residual-stage-6). Stage 3
> (port E2E shards onto the dummy target) is largely gated by the same tenancy
> bug — most CRUD create paths need `activeTenantId`, which is sourced from a
> Cognito JWT claim a local cookie session can't supply, so the bulk port waits
> on identity-federation Stage 3 (which also unskips the entity-create test).
> Stage 5 (coverage gaps) is the open, unblocked item — increments landed:
> (a) regression tests lock the two bugfixes the lane surfaced
> (`database-connection-manager.test.ts` SSL-conditional cases;
> `graph-factory.test.ts` shared-instance memoization + close); (b) the
> previously-untested route files now have auth-gating + registration tests
> (`routes/parental-controls.test.ts`, `routes/tenants.test.ts`) and the
> API-wide error envelope is locked (`routes/errors.test.ts`). Remaining
> untested route surface is just `oauth.ts` (covered functionally under
> `test/unit/oauth/`) and the type-only `types.ts`. (c) The two
> highest-consequence untested **pure** modules on the federation/auth path
> now have direct contract tests: `tenant/resolve-role.test.ts` locks the
> JIT IdP-group→TenantRole algorithm **and** the OWNER-cap defense-in-depth
> backstop (no mapping or default-role may ever resolve to OWNER — a
> privilege-escalation guard); `net/trusted-client-ip.test.ts` locks the
> `TRUSTED_PROXY` mode normalisation and the spoof/SSRF behaviour it gates
> (rightmost-XFF-only for ALB, CF-Connecting-IP for Cloudflare, reserved-block
> rejection). The latter surfaced a worth-knowing footgun: the RFC 5737
> documentation IP ranges everyone reaches for in tests (`203.0.113.x` etc.)
> are themselves RFC 6890-reserved, so the foundation's SSRF guard returns
> `"unknown"` for them — assertions that retain a client IP must use
> genuinely-routable public addresses. (d) A parallel fan-out then closed the
> seven highest-value untested **pure** federation/auth modules in one pass
> (~213 tests): `auth/role-grants` (the GUEST⊂MEMBER⊂ADMIN⊂OWNER capability
> hierarchy the docstring claimed but never asserted, plus the exact
> OWNER-only {tenant.delete, tenant.suspend} diff), `auth/idp-redirect-builder`
> (server-fixed OAuth scope — no scope-injection), `audit/pii-filter` (the
> allowlist + the `deviceCodeHash`-stays-redacted regression guard),
> `audit/csv-export` (RFC 4180 escaping), `tenant/domain-validator` (PSL +
> reserved-namespace rejection), `tenant/derive-domain` (conservative
> email-domain parse — the cross-tenant-isolation guard), and `tenant/idp-name`
> (the 32-char Cognito-quota truncation boundary). No source was weakened to
> make a test pass. The pass surfaced one **latent** hardening gap (CSV
> formula-injection — not exploitable at the current call site; see
> [standalone.md](standalone.md#latent-hardening-notes-not-live-bugs)). (e) A
> second parallel batch covered three more untested modules (~74 tests):
> `auth/cognito-jwt` (Tier-1 — JWKS-verifier lazy/24h-refresh lifecycle, the
> S1.5 retry-once-on-`MultiPoolVerifierError` path, claim narrowing with
> `cognito:username` precedence, missing-env guard), `terminology` (the
> default/override resolution contract), and `database-wrapper-helper` (the
> monitoring Proxy routes model calls through `wrapper.execute` with the right
> `operation` label while `$connect`/`$disconnect`/`$transaction` bypass
> wrapping). The terminology suite surfaced a real shared-mutable-state bug
> (fallback returned the default constant by reference) — fixed + regression-
> locked (bug #4 in [standalone.md](standalone.md#bugs-this-lane-surfaced-all-in-trellis-not-the-foundation-packages)).
> Modules deliberately NOT unit-tested as theatre/over-mock risks:
> `compliance/baseline.ts` (a static constant), `feed-personalization.ts`
> (remaining logic is DB-orchestration; pure scoring lives in extensions), and
> the type-only `*/types.ts` files. (f) A third parallel batch covered the
> federation T5 DB handlers and two leaf modules (~143 tests): `tenant/
> domain-verifier` (fail-closed DNS TXT verification — chunk-join, exact-match,
> ENODATA/ENOTFOUND vs generic-error mapping), `tenant/role-mapping-handler`
> (CRUD + the OWNER-write-reject 422 invariant + P2002→409 + auth-gating),
> `tenant/member-handler` (the full single-OWNER guard set — no promote-to /
> demote / remove / self-modify of OWNER, transfer-ownership gating, cross-tenant
> scoping), `tenant/domain-handler` (claim/list/verify/remove incl. token
> expiry, rate-limit 429, failure auto-rotation, cross-tenant 404, no-verify-
> without-DNS-match), and the `sso-auth-handler` 410 deprecation stub. The
> handler suites use the documented mock pattern (mock `createPrisma` +
> `emitTenantAudit`, spread-actual mock for the auth guards preserving the real
> `Capability`, real `zod`). This batch surfaced a second **latent** gap: domain
> mutations emit no audit events while their sibling handlers do — a
> deliberate-looking deferral that needs an audit-taxonomy decision, documented
> in [standalone.md](standalone.md#latent-hardening-notes-not-live-bugs) rather
> than guessed at. Driving the broader tier branch thresholds is the ongoing
> remainder. (g) A fourth parallel batch covered the federation route layer +
> the large IdP handler (~121 tests): the four `routes/tenant-{domains,idp,
> members,role-mappings}` files (registration shape + CSRF-on-mutating +
> every-route-401-unauthenticated, mirroring `routes/tenants.test.ts`),
> `routes/auth-discover` (the pre-login discovery endpoint — locks no-auth,
> 429+Retry-After rate-limit, input-validation 400s, and the **no-leak**
> property: the query gates on `verifiedAt` AND `identityProvider.status:
> ACTIVE`, so a claimed-but-disabled-IdP domain is indistinguishable from an
> unknown one), and `tenant/idp-handler` (~908 lines, 72 tests — auth-gating on
> every method, zod validation, the connect/patch/disable/delete lifecycle with
> Cognito-SDK + Secrets-Manager mocked, rollback paths, error→status mapping,
> single-IdP invariant, issuer-probe SSRF gate, and `clientSecretArn` never
> appearing in any response). idp-handler emits `tenant.idp.*` audit events on
> every mutation — confirming the domain-handler audit omission (finding above)
> is a deliberate deferral, not a systemic gap. Deferred within idp-handler:
> the best-effort global-signout (dynamic SDK import) and the advisory-lock SQL
> hash (documented in the suite). (h) A fifth parallel batch reached into the
> graph/ActivityPub + leaf layers (~124 tests): `activitypub/crypto` (AES-256-GCM
> round-trip, GCM tamper-detection, the ACTIVITYPUB_KEY_ENCRYPTION_KEY→
> SESSION_SECRET key-derivation fallback, missing-key throw),
> `graph/dual-write-service` (the retry/exponential-backoff logic under fake
> timers — non-critical syncs return queued/failed and never throw, critical
> ops throw `GraphSyncError`, the inline-retry **circuit cap** is honoured so
> there is no unbounded retry, async-enqueue on/off, `processRetry` redispatch),
> `activitypub/audience-service` (every createAudience validation guard +
> member-CRUD incl. suspended/deleted rejection and P2002-idempotent re-add),
> `taxonomy-handler-factory` (the null-not-default-tenant security contract),
> and `audit-actions` (taxonomy invariants — dotted-lowercase format, value
> uniqueness, AuditEventType map integrity). No bugs found; no source weakened.
> The remaining untested surface is the heaviest graph/ActivityPub pieces
> (`neo4j-graph-service`, `reconciliation-service`, the Fedify
> dispatchers/config) plus `notification-preferences-handler`, the
> media-reconciliation queue consumer, and the constant-only/type-only modules
> (deliberately skipped). (i) A sixth batch covered the remaining
> lightly-mockable handlers/leaf modules (~52 tests): `notification-preferences-handler`
> (the CHILD→403 child-safety guard, boolean validation, upsert happy path, and
> `db.release()` in finally on every path — no connection leak),
> `queue-consumers/media-reconciliation-consumer` (the ack-on-success /
> retry-all-on-failure DLQ contract — no silent message loss), the
> `activitypub/friendship-service` stub (no-ops + empty returns, so the
> deprecated path can't silently return real data), and `auth/capabilities`
> (catalog invariants: ALL_CAPABILITIES completeness, value uniqueness, naming
> — which surfaced the `manage:agent_sessions` colon-vs-dot outlier, recorded as
> a minor note in standalone.md). No bugs found. (j) A final unit batch took the
> two remaining modules that had real mockable logic (~64 tests):
> `graph/reconciliation-service` (the bulk Postgres→graph rebuild — locks
> termination, the consecutive-failure **circuit breaker at exactly 10**, the
> `maxRecordsPerModel` cap, cursor pagination, the 100-entry error-tracking cap,
> and `checkConsistency`; surfaced a minor finding — the cap is page-granular,
> noted in standalone.md) and `entity-tagging-errors` (the error code/HTTP-status
> contract handlers map onto responses).
>
> **Unit-test pass substantially complete.** Everything still untested is now
> either (a) **type/constant-only** (`*/types.ts`, `compliance/baseline.ts`) or
> (b) **genuinely infra-bound** — `neo4j-graph-service` and `graph-schema-init`
> (real Neo4j driver/Cypher → the `test:graph` lane against the Dockerised
> Neo4j), the Fedify `dispatchers/`, `fedify/config`, `entity-profile-service`,
> and `routes/activitypub/entity-profile` (ActivityPub is disabled-by-default and
> Fedify-bound → the standalone lane with `features.activityPub` enabled), or
> `session-cookie` (already covered transitively by `session-manager.test.ts`).
> Adding unit mocks for these would be over-mock theatre; the next real coverage
> step for them is the graph/standalone integration lanes, not more unit suites.

## Estimate

**~3–4 weeks** of focused single-developer work. Stage 1 (the dummy target +
standalone lane) is the critical path and the highest-leverage ~1 week; the
rest is incremental and can land PR-by-PR without blocking.

## Sequencing

```
Stage 0  Baseline & guardrails        ─┐ (0.5d, do first)
Stage 1  Dummy target + standalone     │ ← critical path, biggest win
Stage 2  Enforce independence in CI    │
Stage 3  Port E2E shards to standalone │ (parallelizable after Stage 1)
Stage 4  Extension-API contract tests  │
Stage 5  Close coverage gaps           │ (ongoing, parallel)
Stage 6  Define the consumer residual ─┘ (last; documents what we can't cover)
```

Stages 3–5 run in parallel once Stage 1 lands. Stage 2 should follow Stage 1
closely so independence is enforced, not merely possible.

---

## Stage 0 — Baseline & guardrails (0.5 day)

Establish the starting line so progress is measurable and nothing regresses.

- [ ] Capture the current coverage baseline: `npm run test:coverage` → record
      lines/branches/functions/statements in [coverage.md](coverage.md).
- [ ] Confirm the full local stack comes up: `bash scripts/dev-setup.sh`,
      `docker compose up`, `npm test`, `npm run test:integration`.
- [ ] Confirm `bash apps/api/scripts/smoke-pack.sh` passes on a clean checkout.
- [ ] Add Neo4j to [`docker-compose.yml`](../../../../docker-compose.yml) so
      `npm run test:graph` needs no manual setup.

**Deliverable:** a green baseline + a one-command local stack.
**Done when:** a fresh clone reaches a green `npm test` + `test:integration` +
`test:graph` from `docker compose up` alone.

---

## Stage 1 — Dummy target + standalone lane (critical path, ~5 days)

The core of the strategy: a generic reference extension and a config that
boots the real server against local infra, so the full HTTP path runs here.
Design detail in [standalone.md](standalone.md#the-generic-dummy-target).

- [ ] Create `apps/api/test/fixtures/example-extension/index.ts` exporting:
  - [ ] `exampleExtension` — neutral terminology (`widget`/`widgets`),
        exercising **every** optional `TrellisExtension` surface
        (`metadataSchema`, `routes` + `extensionRoutes`, `configSchema`,
        `hooks`, `taxonomySeed`, `relationshipSignalProvider`,
        `entityRelationshipTypes`, `discoveryFacets`, `computeLifeStage`,
        `init`/`shutdown`, `activityPub.enrichActor`).
  - [ ] `minimalExtension` — only the required fields (`id`, `terminology`,
        `routes`, `metadataSchema`).
- [ ] Create `apps/api/test/fixtures/example-extension/boot.ts` —
      `registerExtension(exampleExtension)` + `startServer()` on `localhost:3000`.
- [ ] Auth helper: mint an encrypted session cookie via `SessionManager`
      (`src/lib/session-cookie.ts`) with a fixed test `SESSION_SECRET` — no
      Cognito round-trip.
- [ ] Add `apps/api/vitest.standalone.config.ts`:
  - [ ] `globalSetup` brings up compose, runs `prisma migrate deploy` + seed,
        boots the dummy target, waits on `GET /health`.
  - [ ] `globalTeardown` stops the server and tears down compose volumes.
  - [ ] `setupFiles` provides the cookie-auth helper to test files.
- [ ] Add `apps/api/test/standalone/` with first suites:
  - [ ] health + security headers + CORS on the booted server.
  - [ ] entity CRUD against the dummy extension (validates `metadataSchema`).
  - [ ] one `extensionRoutes` happy path + auth-required rejection.
- [ ] Add the `test:standalone` npm script in `apps/api/package.json`.

**Deliverable:** `npm run test:standalone` exercises the real request path with
a registered extension, zero AWS, zero consuming vertical.
**Dependencies:** Stage 0 (Neo4j in compose for graph-touching routes).
**Risk:** the server's `buildEnv()`/`validateEnv()` may demand vars that assume
deployed infra — resolve by providing local/LocalStack equivalents in
`globalSetup`, not by weakening validation.

---

## Stage 2 — Enforce independence in CI (~1 day)

Make independence a gate, not an aspiration.

- [ ] Add a `standalone` job to [`ci.yml`](../../../../.github/workflows/ci.yml):
      Postgres + DynamoDB-local + LocalStack (+ Neo4j) service containers, then
      `npm run test:standalone`.
- [ ] Extend `smoke-pack.sh` to assert the `example-extension` fixture is
      **absent** from the packed tarball (fixtures must never ship).
- [ ] Update [ci-cd.md](ci-cd.md) so the `standalone` job appears in the
      "runs in this repo's CI" column.

**Deliverable:** a PR that breaks the extension contract or the full path fails
CI here, before publish.
**Done when:** the `standalone` job is required on `main`.

---

## Stage 3 — Port E2E shards to the standalone lane (~4 days, parallelizable)

Move the bulk of E2E coverage off the deployed environment. Existing shards:
`smoke`, `crud`, `social`, `media`, `security`, `readonly`.

- [ ] Make E2E suites target-agnostic: resolve base URL + auth through one
      indirection so the same test body runs against a deployed env *or* the
      dummy target.
- [ ] Port read-only + CRUD + social shards to run under
      `vitest.standalone.config.ts` (cookie auth instead of Cognito magic-link).
- [ ] LocalStack-back the media + queue paths so the `media` shard runs locally.
- [ ] Leave a thin deployed-only smoke shard (the genuinely edge/Cognito bits)
      for the consumer pipeline; document the split in [e2e.md](e2e.md).

**Deliverable:** most E2E coverage runs in this repo; deployed E2E becomes a
thin confirmation layer.
**Dependencies:** Stage 1.
**Risk:** Cognito-specific assertions (token shape, magic-link) can't move —
keep them in the deployed shard rather than faking them.

---

## Stage 4 — Extension-API contract tests (~2 days)

Lock the published contract so downstream breakage surfaces here.

- [ ] Contract suite over `registerExtension` + boot using both fixtures:
  - [ ] `minimalExtension` boots and serves with all optional fields omitted.
  - [ ] reserved/invalid `id` is rejected by `validateExtensions`.
  - [ ] a `configSchema` with a missing required env var **halts boot**.
  - [ ] `metadataSchema` rejection returns a 4xx on entity create.
  - [ ] hooks fire after the operation commits; `init`/`shutdown` order holds.
- [ ] Snapshot the public export surface of `apps/api/src/index.ts` so removed
      or renamed exports fail a test (consumer integration risk shifts left).
- [ ] Cross-check against the [Release Checklist](../../../../CLAUDE.md): an
      `extension-api` bump that breaks the contract fails here pre-tag.

**Deliverable:** the extension API has executable contract coverage.
**Dependencies:** Stage 1 (fixtures + boot).

---

## Stage 5 — Close coverage gaps (ongoing, parallel)

Drive the tier requirements in [strategy.md](strategy.md#coverage-requirements-by-module-type)
to threshold. Use real data, not the (now-stale) fixed gap list.

- [ ] Run `npm run test:coverage`; rank `src/**` files by uncovered lines.
- [ ] **Tier 1 (>90% branch):** verify session, CSRF, MFA, encryption, user
      deletion, security headers, and the Lambda triggers all meet the bar;
      fill the lowest-covered first.
- [ ] **Tier 2 (80%):** handlers, routes, feed personalization, media,
      relationships — close route files lacking tests.
- [ ] Add boundary + failure-path cases per the handler/Lambda/route tables in
      [testing.md](../testing.md#what-must-be-tested) (not just happy paths).
- [ ] Apply the infinite-loop-prevention cases (max-iteration, circuit breaker,
      empty-result) to pagination/polling/cleanup code.
- [ ] Keep coverage non-decreasing; update the baseline in [coverage.md](coverage.md).

**Deliverable:** every tier meets its threshold; coverage ratchets up.
**Note:** this stage never fully "completes" — it's the steady-state discipline
the rest of the plan exists to make cheap.

---

## Stage 6 — Define the consumer residual (~0.5 day, last)

Make the boundary explicit and small.

- [ ] Document the verification set that genuinely requires deployed AWS:
      real Cognito triggers in a live pool, ECS Fargate connection-pool
      behaviour under concurrency, the CloudFront→ALB→ECS edge path, regional
      data-residency routing.
- [ ] Confirm each item truly cannot move to standalone (or file a follow-up if
      it can).
- [ ] Cross-link the residual from [standalone.md](standalone.md) and
      [ci-cd.md](ci-cd.md) so the consumer pipeline owns exactly that set.

**Deliverable:** a short, honest list of what only the consumer can verify —
everything else is covered here.

---

## Definition of done (whole plan)

- `docker compose up && npm run test:standalone` exercises the full request
  path with a registered extension and no AWS.
- CI gates layers 0–2 **plus** the standalone lane and the consumer-install
  smoke on every PR to `main`.
- The extension API has executable contract + export-surface coverage.
- Coverage tiers meet thresholds and ratchet up.
- The deployed-only residual is documented and minimal.
