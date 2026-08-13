# Changelog

All notable changes to Trellis are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Trellis publishes two npm packages from this repository, each with its own tag
series:

- `@de-otio/trellis` — tags `v<x.y.z>`
- `@de-otio/trellis-extension-api` — tags `extension-api-v<x.y.z>`

Entries below are for `@de-otio/trellis` unless noted otherwise.

## [Unreleased]

### Added

- **`@de-otio/trellis-extension-api` 0.9.1 — an extension can now type its own
  models.** `ScopedDb` takes an optional `TModels` parameter, threaded through
  `ExtensionDb`, `ExtensionContext`, `ExtensionJobContext`,
  `ExtensionRouteDefinition`, `ExtensionJobDecl`, `ExtensionHandler` and
  `TrellisExtension`. New exports: `ScopedOf`, `ScopedOperation`,
  `ExtensionModelMap`, `OpenScopedModels`, `CoreScopedModels`.

  ```ts
  type DogModels = { extDogProfile: ScopedOf<Prisma.ExtDogProfileDelegate> };
  export const dogExtension: TrellisExtension<DogModels> = {/* … */};
  ```

  `ctx.db.tenant(tid).extDogProfile.findMany({ where: … })` is then typed
  against the schema, and `extDogProfiles` is a compile error rather than a
  runtime `undefined`. `ScopedOf<T>` keeps exactly the thirteen scoped
  operations `T` has and structurally drops the rest, `$queryRaw` included.

  **Additive.** Every parameter is defaulted to the previous open index
  signature, so an extension that declares nothing is unaffected — which also
  means it keeps the misspelling hazard. Declaring the map is the fix.

  Two declaration sites changed form: `ExtensionRouteDefinition.handle` and
  `TrellisExtension.extendRecap` are now methods rather than function-typed
  properties. Under `strictFunctionTypes` the property form compares
  parameters contravariantly, which would have made a typed extension
  unassignable to the untyped `TrellisExtension` core's registry holds — the
  feature would have been unusable for any extension with routes. Method
  parameters compare bivariantly. This is a variance change only; no call
  signature moved.

  Verified by type-level tests
  (`packages/extension-api/type-tests/generic-scoped-db.test-d.ts`) run as
  their own CI step, because `expectTypeOf` in a vitest file is a runtime
  no-op and `apps/api`'s `tsc --build` excludes `test/`. Every negative case
  is an `@ts-expect-error`, so the check fails if the error it asserts stops
  occurring.

### Removed

- **`@de-otio/trellis-extension-api` 0.9.0 — BREAKING: seven declared
  extension points that core never invoked are gone.** `hooks` (all five
  lifecycle callbacks, plus the `ExtensionHooks` type and core's hook
  dispatcher), `init`, `taxonomySeed`, `relationshipSignalProvider`,
  `entityRelationshipTypes`, `discoveryFacets`, and `recommendationStrategy`,
  together with the types that existed only to serve them
  (`TaxonomySeedData`/`Dimension`/`Category`/`Taxon`,
  `RelationshipSignalProvider`, `RelationshipSignalContext`, `DiscoveryFacet`,
  `RecommendationStrategy`, `Recommendation`).

  These type-checked, registered without complaint, and then did nothing. Two
  of them were worse than silent: `entityRelationshipTypes` and
  `discoveryFacets` were read at registration **only to log themselves**, so
  an author saw `[extensions] "x" registered discoveryFacets: breed(exact)` at
  boot and reasonably concluded the facets were live. Nothing consumed them.

  This is a **removal, not a deprecation**, and it lands before 1.0
  deliberately: from 1.0 the published contract accretes external dependents,
  and dead surface removed later is a breaking change, whereas dead surface
  removed now is a correction. Reintroducing any of these when a real consumer
  exists is an additive, non-breaking change.

  **If you declare any of them:** delete the declaration and the code behind
  it. Nothing observable changes — it was never running. The removals are
  visible in
  `packages/extension-api/etc/public-api.snapshot.d.ts`.

  Documentation that promised behaviour for these fields has been corrected
  rather than deleted: the graph concept doc no longer shows an
  `extension_signals(...)` term in the scoring formula (the scoring engine has
  no extension input and never had one), and the standalone-testing doc no
  longer claims the fixture verifies that "hooks fire after the operation
  commits".

### Added

- **A media-moderation backend no longer has to be shaped like one particular
  cloud's video-moderation service.** An image classifier is now sufficient to
  moderate video, a completion is signalled with a small documented envelope,
  and the operator — rather than the vendor — can own the policy that turns
  labels into decisions.

  - **Frame-sampled video.** `FrameSamplingVideoModerationAdapter` samples
    stills at the operator's rate, classifies each through the existing image
    seam, and aggregates: quarantine dominates, the worst frame wins, and zero
    frames, a decode shortfall, or a plan that exceeds the per-job ceiling all
    resolve to `review`. Only a complete set of approving frames approves. It
    resolves inline, so there is no completion notification to wire up.
  - **A canonical completion envelope**: `{ track, jobId }`. The historical
    wire shapes still parse, so an existing backend needs no change.
    `completionEnvelopeBody()` and `parseCompletionEnvelope()` are exported.
  - **An operator-owned label policy.** `createLabelPolicy()` maps opaque
    category tokens to confidence bars, quarantines anything unmapped, and
    requires a verifiable taxonomy version before it will approve. It is
    floored at the provider's own decision, so it can only degrade a verdict
    and never loosen one — a provider's fail-closed `review` stays `review`.
    Install it with `setMediaLabelPolicy()`; pass it to the frame-sampling
    adapter as `policy` to govern video frames too.
  - **A deadline wrapper** that binds the _decision_, not merely the wait: a
    provider resolving `approved` after the deadline is discarded.
  - **A bytes capability** so a classifier that takes an image in its request
    body needs no storage credentials of its own — the read is size-capped and
    pinned to the recorded version.
  - **A self-identifying provider.** `MediaModerationProvider.name` — optional,
    so no existing adapter breaks — lets core attribute work on the paths where
    there is no verdict to read a provider off: a throw, a deadline breach, or a
    cache lookup that precedes the call. Read it with
    `moderationProviderName()`, which treats an empty or non-string name as
    `unknown` rather than as an identity. Core's own wrappers pass the inner
    name through unchanged, so putting a classifier behind a deadline and a
    frame-sampling adapter does not split its counters across three identities.
  - **Pins, model versions, and abort signals** on the seam itself:
    `MediaPin` (version id / entity tag / content hash) on `ImageRef` and
    `S3Ref`, `modelVersion` on a verdict, `AbortSignal` on every method, and a
    typed `ModerationProviderError` so core classifies failures from a contract
    rather than from vendor error names.

  The seam is re-exported from the package root, so an adapter can be written
  against published names rather than deep paths into `dist/`. Package
  resolution is unchanged — no `exports` map is declared, so every specifier
  that resolves today keeps resolving.

  See [Implementing a media-moderation
  provider](docs/guides/implementing-a-media-moderation-provider.md) and
  [Media moderation
  configuration](docs/reference/media-moderation-config.md).

- **A verdict now carries its own identity and its evidence.** Moderation jobs
  record the provider, the taxonomy version, and the sampling-policy version
  alongside the content hash, plus the per-frame decisions, labels, offsets,
  and the count of frames that never produced a verdict. A policy version is
  recorded even when the operator names none, as a one-way fingerprint that
  changes if and only if the policy changed. All of it is **server-side only** —
  confidences and frame timings are a tuning oracle — and it is captured at
  scoring time because the frames it describes are deleted moments later.

### Fixed

- **A human approval now promotes the bytes that were reviewed.** Approving a
  review-queue item performs the same version-pinned copy the automatic path
  performs, and refuses when that version can no longer be resolved. It never
  resolves "whatever is at the staging key now": between the review and the
  click, that key may hold something else, and copying it would launder
  unreviewed bytes through a human decision. A missing object, an unresolvable
  pin, or a failed copy all hold the item in review. **Wire it with
  `setMediaReviewPromotion()`** (or pass it to `MediaReviewHandler.decide()`
  directly); without it the previous behaviour stands and every approval logs
  that nothing was copied to the serve prefix.
- **The poster still emitted during video processing is now deleted** on every
  exit from the worker. Nothing downstream consumed it, so it was left behind
  as an un-moderated frame of a possibly-quarantined object.
- **Audio-only uploads are refused at intake** with a specific error
  (**BREAKING** for any consumer that accepted them). The pipeline resolves a
  visual track an audio-only object does not have, so accepting one stored
  bytes that no verdict could settle — a row neither servable nor rejected,
  invisible to the uploader and to the review queue alike.
- **A completion message can no longer silence a verdict.** The `track` in a
  completion body is a routing hint checked against the job row; a mismatch is
  dropped _before_ the dedupe claim, so a forged track cannot burn the slot the
  genuine completion needs. Bodies over 256 KiB are refused before parsing (the
  same bound applies to a wrapped inner payload), and provider-supplied ids are
  control-character stripped and length-capped before reaching a log line.
- **An unattributable provider failure now raises an infrastructure signal** as
  well as holding the media. Fail-closed otherwise makes an outage look exactly
  like a busy moderation week.
- **Boot refuses to serve with the fail-closed Null moderation provider outside
  dev**, unless `MEDIA_MODERATION_ALLOW_NULL=true` says otherwise explicitly.

- **Inline video verdicts need two more things from a consumer's persistence
  adapter**, and say so rather than guessing: `MediaFileRow.lifecycle` (so a
  redelivered message cannot compute a transition from a state the object left
  long ago — including reversing a moderator's rejection) and
  `persistMediaStatus`, which must be a conditional write. Without either, an
  object whose tracks all resolve during processing is held for human review
  instead of being settled from an assumption. `MediaProcessingDeps.emitResolved`
  is likewise optional, and without it a client waiting on the upload
  notification for such an object is not told it settled.

### Changed

- **`@de-otio/trellis-extension-api` 0.9.0 — package hygiene for extension
  authors.**

  - **`ExtensionJobContext.signal` is now part of the public type.** Core
    always supplied it; the type did not declare it, so a job that wanted to
    observe its own timeout had to cast. Cooperative cancellation is now
    expressible without one.
  - **The package compiles under `NodeNext`** instead of `node` resolution.
    This package is `"type": "module"`, and NodeNext is what makes TypeScript
    _enforce_ the mandatory `.js` specifier on relative imports — under the
    old setting a missing extension compiled clean here and failed only at
    runtime in a consumer. Verified by removing one and watching `TS2835`
    fire.
  - **BREAKING (resolution): an `exports` map is declared, exposing the
    package root and `./package.json` only.** Deep specifiers such as
    `@de-otio/trellis-extension-api/lib/index.js` now raise
    `ERR_PACKAGE_PATH_NOT_EXPORTED`. No known consumer used one — a repo-wide
    search across core and the reference vertical found zero. `main`/`types`
    remain for older resolvers.

    Declaring `exports` **disables Node's extension probing**, which is how an
    identical map on `@de-otio/trellis` broke twenty of twenty-one consumer
    entry points earlier this month. So this map was verified the way that
    incident said to verify one — by packing a tarball, installing it into a
    fresh project, and loading it — and the consumer-install smoke test now
    loads `@de-otio/trellis-extension-api` from the packed tarball under both
    ESM and CJS, and cross-checks the packed version against
    `EXTENSION_API_VERSION`. That coverage did not exist before; the script
    packed this package and never loaded it, which is precisely why the
    sibling package's breakage reached a merge.

  - **The published tarball now ships `src/`.** Declaration maps were already
    published and pointed at sources that were not, so go-to-definition
    dangled. Compiled `.d.ts`/`.d.ts.map` artifacts that accumulate under
    `src/` in a working tree are explicitly excluded, so a dirty tree cannot
    leak them into a release.
  - **The version-lockstep gate now also checks what each consuming workspace
    says it accepts.** The version is stated in five places, not three, and the
    0.9.0 bump initially moved only three: `apps/api` and `apps/worker` were
    left declaring `^0.8.0`, a range that _excludes_ 0.9.0, because below 1.0.0
    a caret pins the minor. Nothing local caught it — a `node_modules` tree
    installed before the bump keeps its workspace symlink regardless of the
    range, so the typecheck, the full unit suite, and even the packed-tarball
    smoke test all passed against a dependency graph that could not be
    reinstalled from scratch. Only `npm ci` on a clean checkout objected. The
    gate now reproduces that failure in under a second, and understands only
    the plain caret form, throwing on any other range shape rather than
    guessing at it.

- **Six read paths could disclose a post to someone its author had not
  admitted.** All six are closed. Every one is a _narrowing_: nothing changes
  shape, and things that used to be served are now withheld. Consumers should
  expect fewer results, not different ones.

  The common thread is worth stating once, because it explains five of the six:
  an audience decision was being made somewhere other than where the audience is
  defined — from the reader's data, from a stale copy, or from a default applied
  when the answer was unknown.

  - **BREAKING:** circle visibility is decided from the **author's**
    relationship edge, not the reader's. `tier` derives from
    `COALESCE(manual_score, computed_score)`, and a reader can set `manualScore`
    on their own edge via `PATCH /api/relationships/score` — so reading the
    reader's edge handed the audience boundary to the reader. Access now also
    requires `reciprocated: true`.

    **The practical effect: a one-way follow no longer grants access.** Where A
    had classified B as close without B reciprocating, B loses read access that
    previously worked. That is the definition of the boundary, not a side
    effect of the fix.

  - **BREAKING:** friends-only access reads the author's edge and requires
    mutual consent, for the same reason.
  - **BREAKING:** the unauthenticated ActivityPub outbox collection is
    audience-gated. Retroactive narrowing, hiding and deletion now take effect
    there. The item list and `totalItems` come from a single fragment, so
    pagination cannot disclose a count the page itself withholds.
  - **BREAKING:** ActivityPub object routes no longer fail open when the
    audience is unknown, and every deny is byte-identical — a deny cannot be
    distinguished from a miss.
  - **BREAKING:** attachments inherit the audience decision of the post they
    belong to. Previously the post was withheld and its media was not.
  - **BREAKING:** the public-posting kill switch also covers system posts,
    which could previously bypass it and cost the operator control silently.

  Note what is **not** fixed: the write paths remain audience-blind, so do not
  read these entries as "post visibility is now correct". They close read
  disclosure only.

- **`@de-otio/saas-foundation` floor raised to `^0.4.3`** (was `^0.4.0`), in
  `apps/api` and `apps/worker`.

  0.4.3 is what teaches `createDefaultS3Client` to read an optional,
  S3-specific `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` pair. That matters
  wherever object storage and message queues issue **separate** credentials: the
  AWS SDK reads one credential pair from the environment for all services, so
  the S3 client would otherwise sign as whichever principal owns the ambient
  `AWS_*` pair and get a 403 — indistinguishable from a permissions problem.

  The floor is load-bearing rather than incidental. The old `^0.4.0` caret
  already _accepted_ 0.4.3, but it also accepts 0.4.0, and an install that
  resolved the older version would leave object-storage uploads failing with no
  signal beyond a 403. Deployments on AWS are unaffected either way: with no
  `S3_*` variable set the factory behaves exactly as before.

### Added

- **`POST /auth/register` — invitation-gated registration on a brokered IdP.**
  On the Cognito path registration is client-side (`Amplify.Auth.signUp`, with
  the PreSignUp trigger running the invitation gate server-side and the signup
  attributes riding the trigger event). A brokered IdP has no hook the client
  can reach, and the client must never hold the realm admin credential — so
  **a Keycloak deployment could sign existing users in but could not register
  new ones at all.** Worse than an outright failure: `POST /auth/magic-link`
  never passes `forceCreate`, so an unknown email returned the deliberate
  anti-enumeration `200 {"status":"sent"}` while creating no user and sending
  no mail.

  The endpoint validates the invitation code **before** creating the user
  (fail-closed; a rejected attempt leaves nothing behind that could later be
  sent a sign-in link), then creates it carrying the attributes the app
  provisions from on first sign-in — `invitationCode`, `dateOfBirth`,
  `guardianEmail`, `handle`, `signupMethod`. Those attributes are the point:
  dropping them does not fail, it produces an un-gated adult account.

  The address is **not** created pre-verified — the magic link that follows is
  what proves it. Registration deliberately does not send that link, mirroring
  the Cognito contract so one client flow drives both providers. An
  already-registered email is indistinguishable from a fresh one (C-13/F10) and
  is never rewritten, so a replayed registration cannot overwrite a date of
  birth or re-consume an invitation. Its own 3/900s per-email bucket, separate
  from the sign-in budget, failing closed. Returns 501 on a provider without
  `registerUser` rather than quietly doing nothing.

  Requires `@de-otio/saas-foundation` with the optional `registerUser` port
  method.

- **`GET /api/users/me` — the caller's resolved identity.** Returns
  `{ userId, activeTenantId, email, globalRole, tenantSlug, tenantRole,
handle }`, authenticated, `private, no-store`, and included in the
  curated OpenAPI document. It exists so clients stop decoding
  `custom:userId` / `custom:activeTenantId` out of the ID token: those
  claim names are written by a Cognito pre-token-generation Lambda and are
  a per-deployment choice on any other OIDC issuer (a Keycloak realm maps
  whatever its `claim_mappers` say — possibly nothing), so a
  token-decoding client silently receives `null` and degrades. The server
  resolves the identity from the token `sub` instead, so the endpoint
  behaves identically across providers. It is also fresher than a claim:
  `activeTenantId` is correct on the request after a tenant switch rather
  than after the next token refresh. All fields but `email` come from the
  identity `authMiddleware` already resolved; `email` costs one
  primary-key read. Fails closed with `401` if the user row disappears
  mid-request.

- **Client-version policy endpoint + forced-upgrade backstop.**
  `GET /api/app/version-policy` (new, unauthenticated, session-free, no
  DB/KV read — the whole response comes from four optional env vars,
  `Cache-Control: public, max-age=300`, `Access-Control-Allow-Origin: *`
  without credentials) serves `minimumVersion`, `recommendedVersion`, and
  `storeUrls.{android,ios}` — all nullable; unset means the mechanism is
  dormant. Configured via four new optional env vars, boot-validated and
  fail-closed on a malformed value: `CLIENT_MIN_SUPPORTED_VERSION`,
  `CLIENT_RECOMMENDED_VERSION` (bounded semver `x.y.z[+-suffix]`, ≤64
  chars), `CLIENT_STORE_URL_ANDROID`, `CLIENT_STORE_URL_IOS` (must be
  `https:` on `play.google.com` / `apps.apple.com` respectively). Clients
  send `X-Client-Version` / `X-Client-Platform` on every call; a new 426
  backstop middleware returns a `StructuredError` body
  (`UPGRADE_REQUIRED`, no URL in the body) when a configured minimum is
  set and a parsed client version is strictly below it — equal versions
  are allowed, `OPTIONS` is never intercepted, and absent/unparseable
  headers pass through untouched (federation peers, health probes,
  curl). Both new headers are added to `Access-Control-Allow-Headers` at
  every CORS site the request/preflight path uses (`middleware.ts`,
  `cors-handler.ts`), now sourced from one shared
  `CORS_ALLOWED_REQUEST_HEADERS` constant. Version telemetry is emitted
  only for a strictly parsed header, re-serialized from the parsed
  triple (never the raw string), platform coerced to a closed vocabulary,
  and capped at 100 distinct version dimensions per process. See the new
  [Client Compatibility guide](docs/guides/client-compatibility.md).
- **`platform` block on `GET /api/feature-flags`.** Additive: one boolean
  per platform-level feature toggle (`posts`, `comments`, `friends`,
  `sentiments`, `feeds`, `map`, `events`, `collections`,
  `email_subscriptions`, `year_in_review`, `entity_profiles`), resolved
  from `FeatureToggleService` **global** values only — this route is
  unauthenticated and carries no tenant context, so per-tenant overrides
  are not reflected here (they continue to act server-side at
  enforcement). Existing response fields are unchanged. See
  [Feature Flags](docs/guides/feature-flags.md).
- **`extensionApiVersion` startup compatibility check.** `TrellisExtension`
  gains an optional `extensionApiVersion` field — the
  `@de-otio/trellis-extension-api` semver an extension was built against
  (normally just `EXTENSION_API_VERSION` re-exported from the package).
  Core validates it before serving: absent → one warning, never fatal;
  a differing major (or, while the extension API is still `0.x`, a
  differing minor) → **fails startup**, naming both versions; patch
  drift → logged only; an unparseable declared value → a clean
  validation failure, never a deep throw. See
  [Extension API: `extensionApiVersion`](docs/reference/extension-api.md#extensionapiversion).
- **squawk migration lint gate** (`migration-lint.yml`, new, `pull_request`
  only): lints added/changed Prisma migration SQL (pre-existing migrations
  exempt) against `.squawk.toml` (PG 16) using a pinned, checksum-verified
  squawk `v2.62.0` binary — never `npx`/`latest`. Local reproduction via
  `apps/api/scripts/lint-migrations.sh`.
- **Migrations guide expansion**: safe-vs-unsafe Postgres DDL reference
  table, the `lock_timeout` prologue convention for hand-edited
  migrations, an expanded expand-contract sequence (dual-write →
  backfill → shadow-read → toggle-flip → soak → contract, with an RDS
  snapshot before the contract step), and a documented, time-boxed
  pre-launch exemption from staged expand-contract. See
  [Migrations](docs/guides/migrations.md).
- **`migration-rehearsal.sh` + `migration-rehearsal.yml`** (new,
  `workflow_dispatch` only): times `prisma migrate deploy` against a
  configurable time budget so a migration touching a large/hot table can
  be rehearsed before it ships.
- **OpenAPI additivity gate** (`openapi-gate.yml`, new, `pull_request`
  only): a committed snapshot (`apps/api/openapi.snapshot.json`) and a
  pure, unit-tested classifier
  (`apps/api/scripts/openapi-additivity-core.mjs`) fail a PR that removes
  a path, method, or parameter from the currently-generated
  `publicSpec: true` surface (field/type/enum/required-addition rules
  are built and unit-tested against synthetic documents; they become
  live once the OpenAPI generator emits richer schema detail — see that
  script's own documented limitation). `npm run openapi:snapshot` /
  `openapi:check`.
- **Public API type snapshots + version lockstep gate**
  (`api-snapshot-gate.yml`, new, `pull_request` only): committed `.d.ts`
  snapshots for both publishable packages
  (`packages/extension-api/etc/public-api.snapshot.d.ts`,
  `apps/api/etc/public-api.snapshot.d.ts`), diff-gated in CI
  (`npm run api-snapshot:update` / `:check`), plus
  `check-extension-api-version.mjs` failing the build if
  `EXTENSION_API_VERSION` and `packages/extension-api/package.json`'s
  `version` drift apart.
- **Backfill and rebuild script conventions**
  (`apps/api/scripts/backfills/`, `apps/api/scripts/rebuilds/`): READMEs
  documenting the batched/idempotent/throttled/resumable/observable
  rules for one-time backfills versus repeatable denormalized-counter
  rebuilds, a backfill `_template.ts`, and a worked rebuild example,
  `rebuild-collection-item-count.ts` (batched, idempotent, `--dry-run`
  by default). All seven denormalized counters in the current schema are
  enumerated in the rebuilds README, with two documented as **not**
  mechanically rebuildable from current rows (recorded, not
  implemented — see the README for why).
- New [Client Compatibility guide](docs/guides/client-compatibility.md):
  the additive-only API evolution rules, the version-policy contract,
  the `platform` flags block, and the alias-for-one-release standing
  rule for cross-repo renames at either the HTTP or the npm boundary.

### Changed

- **`@de-otio/trellis-extension-api` 0.8.0.** Additive minor bump (from
  0.7.0): adds the optional `TrellisExtension.extensionApiVersion` field
  (see the startup check above and the
  [Extension API reference](docs/reference/extension-api.md#extensionapiversion)).
  No existing extension needs a change to keep working; declaring the
  field is recommended, not required. **`apps/api`'s own dependency
  constraint moves from `^0.7.0` to `^0.8.0`** — a caret range on a `0.x`
  version does not accept a minor bump, so this was required for
  `npm install` to resolve; consuming applications that pin
  `@de-otio/trellis-extension-api` themselves (rather than accepting
  trellis's own dependency resolution) should move to `^0.8.0` too.
- **`npm publish --provenance` enabled** in `publish.yml` now that
  `de-otio/trellis` is a public repository: npm can verify the sigstore
  provenance bundle against the GitHub Actions source repository, so
  published tarballs carry a verifiable build attestation. Requires no
  new secrets — Node 24 + OIDC trusted publishing were already wired.

### Fixed

- **The nightly media purge builds its S3 client through the foundation
  factory.** `apps/worker` constructed one from `region` alone. Off AWS the
  missing half is _credentials_, not the endpoint: `AWS_ENDPOINT_URL_S3` is
  resolved natively by `@smithy/core`, but the SDK reads a **single** ambient
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` pair for every service, so where
  that pair belongs to the queue service the S3 client signs as the wrong
  principal and every delete returns 403.

  The failure was silent by construction. The purge defers the hard-delete of
  any row whose object delete failed — deliberately, so it self-heals — which
  makes a 403 loop indistinguishable from a healthy no-op: nothing surfaces,
  rows never drain, the bucket grows. A source-scan test now forbids direct
  `S3Client` construction outside `src/lambda/**`, which runs only where the
  ambient pair is correct.

- **Health and abuse dashboards no longer report missing data as good news.**
  Two admin surfaces derived a clean bill of health from the _absence_ of a
  reading:

  - `evaluateAbuseMetrics` degraded both data sources to zeros on failure, and
    zeros produced `blockRate 0` → `overallStatus "low"` → the recommendation
    _"No abuse concerns detected in this time period."_
  - `evaluateScalingHealth` derives `"healthy"` from the absence of red/yellow
    indicators, and a CloudWatch failure _removes_ the RDS indicators rather
    than reddening them — manufacturing exactly that absence.

  Both now distinguish "nothing happened" from "nothing was measured", gaining
  a `dataQuality: { degraded, unavailable[] }` field and an `"unknown"`
  `overallStatus`; the all-clear recommendation is suppressed while any source
  is down. **Degraded is a floor, not a ceiling** — a surviving source that
  reports a real problem still escalates to `critical`/`action-needed`, so one
  source failing cannot mask the other's finding.

  Neither type is exported from the package entrypoint or present in the
  OpenAPI snapshot, so the new field and enum member are additive for consumers
  of the published surface.

- **`SessionManager.getSession` now resolves the trellis user id on
  non-Cognito issuers, and fails closed when it cannot.** Trellis has two
  independent Bearer-token paths; 0.24.0 wired Keycloak JIT claim
  resolution into `auth-middleware.ts` only. The other —
  `SessionManager.getSession` Strategy 1a, used by ~46 call sites
  including every media route — still read
  `claims["custom:userId"] || claims.sub`. Keycloak issues no
  `custom:userId` (its realm protocol mappers emit deployer-chosen claim
  names), so `session.userId` silently became the IdP `sub`: a UUID,
  matching no `User.id` (a cuid). Every affected route answered
  _"User not found"_ (404) — the same failure mode as the 0.12.1/0.12.2
  Cognito-era bug, reopened by the provider swap. Strategy 1a now
  (a) validates the claim against `CUID_RE` instead of trusting it,
  (b) falls back to the same server-side resolution auth-middleware uses
  (claims cache → DB by `sub` → first-contact provisioning), which also
  supplies `activeTenantId` and the global role, and (c) **returns `null`
  rather than seating a non-cuid id**.

  **Behaviour change:** a verified token that resolves to no trellis user
  now yields **401** instead of a session that 404s deeper in the stack.
  On Cognito this is reachable only via the known intermittent
  pre-token-generation race (a first token missing `custom:userId`); such
  requests previously produced a confusing 404 and now fail cleanly,
  prompting the client to re-authenticate. Deployments whose tokens always
  carry `custom:userId` are unaffected, and the JIT resolver remains a
  no-op unless `IDENTITY_PROVIDER=keycloak`, so the Cognito hot path skips
  it entirely.

## [0.24.0] — 2026-08-06

Closes out the `0.24.0-alpha.0`–`alpha.3` series; entries below cover
everything since 0.23.0.

### Added

- **AI Act Art. 50 synthetic-content provenance** (phases A, B, D).
  Provenance is read from uploads **before** the metadata strip; declarations
  are accepted with enforced monotonicity (re-attachment inherits the stronger
  declaration); per-tenant disclosure posture (`OPTIONAL` /
  `REQUIRED_FOR_AI` / `PROMPTED`); staff-only audited correction path; the
  extension-API disclosure criterion enforced at the data layer; the label
  federates over ActivityPub; video/audio (timed-media) provenance via the
  worker pipeline. Two schema migrations. Client contract:
  [`docs/reference/provenance-api.md`](docs/reference/provenance-api.md).
  Consumers should implement `MediaPersistencePort.recordEmbeddedProvenance`
  (optional) — until then timed-media provenance is read and discarded,
  signalled by the `provenance.discarded` metric.
- **Keycloak JIT provisioning on first authenticated request** (plan 016
  WS-0). When `IDENTITY_PROVIDER=keycloak` and a verified token carries no
  `userId`/`activeTenantId` claims, the API resolves them server-side
  (claims cache → DB → first-contact provisioning through the
  provider-neutral core), concurrency-safe. The Cognito path is unchanged.
- **Provider-neutral runtime** for non-AWS deployments: Scaleway TEM and
  generic SMTP email providers, OTLP metrics exporter, software HMAC-SHA256
  pseudonym fallback (`PSEUDONYM_MAC_PROVIDER=software`), `OIDC_*` env names,
  a one-shot worker DB-migrate entrypoint, GDPR-deletion identity/email
  ports with a boot-time wiring guard, `WORKER_DISABLED_CRONS`, and
  `SQS_QUEUE_URL_PREFIX` support.
- **O-1 extension-owned schema: first-consumer seam**, and extension-owned
  rows are included in the GDPR data export.

### Fixed

- **Video uploads leaked the uploader's GPS coordinates** through the
  metadata strip (`-dn` never touched the container metadata dictionary) —
  transcode and poster argv now pass `-map_metadata -1`, property-tested.
- **The published tarball shipped no `dist/`** (apps/api inherited the root
  tsconfig's new `noEmit`); caught by the consumer-install smoke gate, never
  published.
- Security hardening: magic-link URL escaped in email HTML (F1);
  create-auth-challenge rate limit fails closed (F2); Keycloak
  privilege-attribute lockdown verified at boot (F3); empty `APP_DOMAIN`
  fails magic-link initiation closed (F4); `OIDC_JWKS_URL` required for
  non-Cognito issuers (SEC-6b); precise location stripped from non-owner
  entity profiles.
- Magic-link emails honour `FROM_EMAIL` + `EMAIL_BRAND_NAME` (CRLF header
  guard included).

### Changed

- **Node ≥ 22 is now declared** (`engines`, `.nvmrc`) — undici v8 is a
  runtime dependency and requires it; previously a Node 20 consumer crashed
  at import with no warning.
- A repo-root `tsc` no longer writes shadow `.js` next to sources (root
  tsconfig `noEmit`); package builds emit explicitly.
- Migration SQL is CI-guarded against unintended `DROP INDEX` statements
  (`scripts/check-migration-sql.mjs`).

## [0.23.0] — 2026-07-16

### Added

- **O-1: extension-owned schema mechanism.** Extensions can now own Postgres
  tables and scheduled work with enforce-always tenant isolation.
  - **Scoped extension-DB surface.** `ExtensionContext.db` is now
    `{ tenant(tenantId): ScopedDb }` — the only way extension code touches
    data. Every operation on the returned `ScopedDb` is tenant-bound by
    construction: by-id ops (`findUnique`/`update`/`delete`) are rewritten to
    tenant-merged `findFirst`/`updateMany`/`deleteMany` with an
    affected-count assertion, FK-target ownership is validated
    read-before-write, cross-model nested writes and relation
    `include`/`select` are rejected, and `queryRaw`/`executeRaw` are not part
    of the surface. Isolation holds independent of core's
    `TENANT_SCOPE_MODE` rollout flag. The prior raw 9-delegate `any` bag on
    `ExtensionDb` is removed (no consumer read it).
  - **In-process extension job runner.** New optional `jobs` field on
    `TrellisExtension`. Declared jobs run inside the API container (never a
    worker Lambda — those load no extensions), single-flighted cluster-wide
    by a DynamoDB conditional-put lock keyed by `job:<extId>:<jobId>`, with a
    TTL sized to the job's own timeout (not a flat hour), a `lockToken` +
    conditional release to prevent lock-stealing after a TTL-expired
    overrun, and a `Promise.race`/`AbortController` timeout on the job body.
    `ExtensionJobContext` exposes cross-tenant read only on the models a job
    declares in `crossTenantRead`, plus `tenant(tid)` for correctly-scoped
    per-row writes. See
    [`doc/02-technical/operations/extension-job-runner.md`](doc/02-technical/operations/extension-job-runner.md).
  - **Fragment composer.** New `trellis-schema compose` build step merges
    extension-owned `.prisma` fragments into the core schema, injects the
    Prisma-required back-relations into core models, validates fragment
    declarations (tenant/entity FK shape, `@@map`/`@map` targets, an explicit
    GDPR `erasure:` directive per model), and can emit a fresh replay
    baseline that preserves core's non-DSL SQL (extensions, expression/GIN
    indexes) via migration replay plus a linted raw-SQL sidecar.
  - **GDPR erasure** now iterates the composed extension-model registry as
    part of the existing per-subject deletion flow, so an extension's
    `erasureSubjectField`-declared rows are deleted with zero extension code.
  - No extension in this repository declares an owned model or a job yet
    (`@skybber/ext-dogs` owns routes and taxonomy seed data, not tables) —
    this release ships the mechanism ahead of its first consumer.

- **05a Part A: verified tenant context for extension route handlers.** An
  extension route handler now receives its caller's verified active tenant as
  `session.tenantId` (a branded `TenantId`), the only way it can obtain one for
  `ctx.db.tenant(tid)`. Resolution is fresh-per-request and verified: the
  active-tenant claim already validated on a Cognito JWT (surfaced from
  `getSession` Strategy 1a) or, for pure cookie sessions, the caller's
  `personalTenantId` read server-side — never a client-supplied value. Minted
  through core's private `mintTenantId(·, "session")` for audited provenance.
  - **`activeTenantId` is verified-per-request only, by construction.** It is
    stripped from all sealed material at the single seal chokepoint
    (`encryptSession`), so the CSRF-refresh and MFA-verify re-seal paths can
    never bake a ≤1h-verified tenant into a 90-day cookie, and it is stripped
    from every decrypted cookie/localStorage payload (`narrowSession`,
    `narrowSessionForAuthHeader`) so a sealed session can never supply one.
  - **The extension session is now whitelist-built**, not the internal session
    passed through — `csrfToken`/`mfaVerified`/`dataRegion`/`ageTier` no longer
    leak past the extension boundary (pre-existing over-exposure, fixed here).

- **05a Part B: sanctioned cross-tenant read path (`ctx.db.discover(reason)`).**
  A named, audited, allow-listed READ-ONLY surface for content that is
  cross-tenant by construction (a caller's feed candidates live in other users'
  personal tenants) — the mirror of L1's `tenant(tid)`. Every guarantee is
  enforced at runtime:
  - **Read-only + audited.** Only the five read methods exist on the facade
    (no write op reachable); each executes inside
    `runUnscoped("ext:<id>:<reason>", …)`, so every cross-tenant read is
    warn-logged and attributable, and `runUnscoped` finally has production
    callers.
  - **Model gate.** Only models the extension declared in the new
    `TrellisExtension.crossTenantRead` (validated at registration against a
    core allow-list — catalog/content only, never user/tenant/entity/auth — ∪
    its own `ext_*` models; **fails startup** otherwise) resolve to a delegate;
    everything else is fail-closed.
  - **Baseline visibility floor**, AND-merged and non-overridable (public/SHOUT
    content, active catalog, caller region) — applied on every read method.
  - **Projection + relation-`where` + column guards.** No `include`/relation
    `select`; relation traversal in `where` to any non-declared model is
    rejected (closing the `author`/`tenant` field-oracle); results are
    restricted to a per-model column allow-list that strips
    `tenantId`/`authorId`/`geoData`/`uri`.
  - **Abuse caps.** `take` clamped (default 50, max 200), deep `skip` rejected;
    the route wrapper attaches rate limiting to every route of an extension
    that declares `crossTenantRead` (discover is reachable from anonymous
    routes).
  - The shared read-only-facade primitive is factored out of the O-1 job runner
    (`extension-read-delegate.ts`) and reused here.
  - (Part C — migrating `@skybber/ext-dogs`' 10 call sites onto `tenant()` /
    `discover()` — lands in skybber against the published 0.7.0.)

### Changed

- **`@de-otio/trellis-extension-api` 0.7.0.** Additive minor bump (from
  0.6.0): adds the named `ExtensionSession` interface (the route-handler
  session param) with its optional `tenantId?: TenantId` (05a Part A), and the
  cross-tenant read surface — `ExtensionDb.discover(reason)`, the `DiscoverDb`
  type, and `TrellisExtension.crossTenantRead?` (05a Part B). 0.6.0 (unreleased
  in this same window) added `ExtensionDb.tenant(tid)` / `ScopedDb` /
  `ScopedDelegate`, the opaque `TenantId` brand (no exported constructor —
  extension code cannot forge one), and `jobs` / `ExtensionJobDecl` /
  `ExtensionJobContext` / `ExtensionJobSchedule` / `CrossTenantReadDelegate` to
  the `TrellisExtension` contract. See the
  [Extension API reference](docs/reference/extension-api.md#scheduled-jobs)
  for the author-facing contract.

## [0.22.0] — 2026-07-10

### Added

- **Events primitive: events, RSVPs with capacity/waitlist, and volunteer shift
  slots.** A new first-class core feature (feature-flagged `events_enabled`,
  default off) for tenant-scoped events. Events carry a status
  (DRAFT/PUBLISHED/CANCELLED), visibility (TENANT_ONLY/GROUP_ONLY/PUBLIC), and
  privacy-graded location (EXACT/NEIGHBORHOOD/CITY/HIDDEN, with fuzzed display
  coordinates for non-exact precision). RSVPs (GOING/MAYBE/NOT_GOING) enforce
  optional capacity with a race-safe waitlist (atomic conditional SQL +
  `FOR UPDATE SKIP LOCKED` promotion); named shift slots (Dienstplan) have their
  own capacity and signups. On publish, an event surfaces in the feed via a
  companion post (mapped from visibility; GROUP_ONLY events post nothing); GOING
  attendees receive `EVENT_UPDATED`/`EVENT_CANCELLED` notifications (debounced).
  New endpoints under `/api/events…` (create/list/mine/get/update/cancel;
  rsvp/withdraw; attendees; shift CRUD; shift signup/withdraw), all gated by
  `events_enabled` and requiring at least the `MEMBER` role. New capabilities
  `EventCreate`/`EventUpdate`/`EventDelete`/`EventModerate`; new `EVENT_*`
  operational env vars (per-tenant/shift/guest caps, RSVP and update rate limits,
  notification cooldown). Reference docs: `docs/reference/events-api.md`.
  Recurrence, ICS export, and reminders are deferred to a later release.
  **Consumer note: ships a Prisma migration adding the events tables and four
  `EVENT_*` `NotificationType` values — run migrations on upgrade. The feature
  stays inert until `events_enabled` is enabled.**

- **Email provider abstraction with AWS SES and Resend support.** Transactional
  emails (magic-link authentication tokens) are sent via a swappable provider
  interface (`EmailProvider`), selected at runtime via the `EMAIL_SERVICE` env
  var (`"aws-ses"` | `"resend"`, default: `"aws-ses"`). AWS SES uses the
  default credential provider chain (role-based on ECS/Lambda, no static keys);
  Resend uses an API key. The abstraction is shared between the API server and
  the Cognito magic-link Lambda trigger (`create-auth-challenge`), ensuring
  consistent provider selection. Email identity provisioning (DKIM, MAIL FROM,
  DMARC, configuration set, bounce/complaint SNS) is handled by the `SesEmailIdentity`
  CDK construct in `@de-otio/saas-foundation-cdk`. Trellis itself requires only
  `FROM_EMAIL` for SES (verified in the sending region) or `RESEND_API_KEY` for
  Resend; all other SES configuration is infrastructure-layer only.

## [0.20.0] — 2026-07-05

### Added

- **Moderator media-review queue (T9).** New MODERATOR/SUPER_ADMIN-only HTTP
  surface over media awaiting a human decision
  (`lib/routes/media-review.ts`, `lib/media/media-review-handler.ts`):
  `GET /api/admin/media-review` (paginated REVIEW/QUARANTINED list with
  per-track visual/audio verdicts for video), `POST
/api/admin/media-review/{id}/decision` (approve | reject), `POST
/api/admin/media-review/{id}/escalate-csam` (locks the item and writes a
  CRITICAL audit row; statutory reporting remains a human/runbook process),
  and `GET /api/admin/media-review/{id}/content` (audited moderator
  byte-view via a new pure `moderator-serve-gate` that serves only
  REVIEW/QUARANTINED items and never widens the public APPROVED-only gate).
  Roles are resolved server-side from the User table; decisions go through
  the existing media lifecycle state machine, and approval fails CLOSED
  when the stored bytes are absent. Every decision and every byte-view
  writes an `AuditEvent`. No Prisma schema change.

### Fixed

- **Five aggregated route sets are now actually served.** A route set listed
  in the `routes/index.ts` aggregate is only served once mounted in
  `lib/app.ts`; five sets added after the router consolidation were never
  mounted and returned 404 in deployments despite green unit tests. Now
  mounted: device registration (`POST /api/devices/register`, `DELETE
/api/devices/{id}`), tenant classification, tenant directory profile,
  tenant directory search, and platform category admin. **Consumer note:
  these endpoints become live on upgrade — anything previously relying on
  them 404ing should be reviewed before deploying.** A new route-mount
  parity guard (`test/unit/route-mount-parity.test.ts`) fails the build if
  any aggregated route is not registered on the built app, closing the
  defect class.

## [0.19.0] — 2026-07-05

### Added

- **Push-device registration + wakeup dispatcher (T8).** New `PushDevice`
  model (migration `20260705171948_t8_push_devices`) and device endpoints
  (`POST /api/devices/register`, `DELETE /api/devices/{id}` —
  `lib/routes/devices.ts`, `lib/push/push-device-handler.ts`). Notifications
  now fan out to registered devices through a consumer-injectable
  `PushTransport` seam (`lib/push/push-transport.ts`,
  `setPushTransportProvider`) driven by a wakeup dispatcher
  (`lib/push/push-dispatcher.ts`); push tokens are encrypted at rest
  (`lib/push/token-crypto.ts`). Contract:
  `apps/api/src/lib/doc/push-device-contract.md`.
- **Real GDPR-erasure e2e (H2/H3).** New integration test drives the
  delete-account worker and the nightly GC purge against a real database and
  real stored bytes, proving end-to-end erasure
  (`test/integration/gdpr-erasure-worker.integration.test.ts`). No source
  change.

### Fixed

- **Presigned byte rail now budgets BOTH tracks of a muxed video (F2).** The
  `content-length-range` cap for a video upload was sized to the video-track
  budget alone, rejecting legitimate clips whose audio track pushed the file
  past that single budget. `presignByteCap()`
  (`lib/media/presign-policy.ts`) now sizes a video rail as the combined
  video+audio per-track budgets (audio stays single-track); the rail remains
  bounded by the operator-configured budgets, and the authoritative limits
  (ffprobe duration cap, tenant quota) are unchanged.
- **Moderated bytes are version-pinned through moderation → promote (F3,
  TOCTOU).** Promotion previously copied whatever bytes currently sat at the
  staging key — not the bytes moderation actually scanned, so a swap at the
  same key between moderation start and promote could serve unmoderated
  bytes. The processing worker now resolves and persists the staged object's
  S3 `versionId` (`stagingVersionId`), hashes and moderates the pinned bytes,
  and the completion worker promotes from that exact version (replays with
  cas/ already present skip the copy). Unresolvable versions fail CLOSED to
  REVIEW — never an unpinned pipeline. `StoragePort` gains `versionId`
  options on get/head/copy; `S3Ref` gains optional `versionId`. No Prisma
  schema change. **Consumer handoff:** requires S3 bucket versioning on the
  media bucket and adapter updates (persist/read `stagingVersionId`, use
  versioned Get/Head/CopySource and Rekognition `S3Object.Version`) —
  otherwise video uploads fail closed to REVIEW.

## [0.18.0] — 2026-07-05

### Added

- **Per-tenant storage-quota entitlement seam (T16).** New nullable
  `Tenant.storageQuotaBytes` / `Tenant.storageQuotaObjects` columns (migration
  `20260705120000_t16_tenant_storage_quota`); the effective quota at both
  upload gates is now `tenant override ?? env default`
  (`lib/media/quota-resolution.ts` — a broken override fails CLOSED via
  `checkUploadQuota`, never widens to the default). No billing/purchase flows
  — an operator (or a future billing system) writes the columns.
- **Quota usage now counts ONLY approved content.** The usage aggregate both
  gates read is scoped by the shared storage-accounting predicate
  (`quotaUsageWhere`: `lifecycle = APPROVED && deletedAt IS NULL` —
  `lib/media/storage-accounting.ts`): users are never charged quota for
  blocked (`REVIEW`/`QUARANTINED`/`REJECTED`) or never-completed uploads, and
  soft-delete frees quota immediately. Pinned decisions (N = 7 d hard-delete,
  X = 24 h abandonment TTL, staging S3 TTLs) in ONE doc section:
  `doc/02-technical/operations/storage-accounting.md`. Four-case integration
  test: `test/integration/storage-accounting.integration.test.ts`.
- **Review-rate cap enforcement (T15c).** `env.media.reviewRateCap`
  (`MEDIA_REVIEW_RATE_CAP`) is now ENFORCED at both upload gates: once a
  tenant accumulates the cap's worth of flagged objects
  (`REVIEW`/`QUARANTINED`) inside the rolling window
  (`MEDIA_REVIEW_RATE_WINDOW_MS`, default 24 h), new uploads are denied 429
  (`lib/media/review-rate-cap.ts`) — one tenant can no longer torch the
  moderation budget or flood the platform-reclaimed storage bucket.

### Fixed

- Stale "quota enforcement is advisory in P0b" comment in `env.ts` — the
  quota has been hard-enforced (413/429, fail-closed 503 on read failure)
  since the P0b hardening.

## [0.17.0] — 2026-07-05

### Changed

- **MediaFile lifecycle consolidation (breaking; pre-launch window, nothing
  live).** The `moderation_status` (enum `ModerationStatus`) + `upload_status`
  (string) column pair is replaced by a single `lifecycle` column driven by
  ONE machine-checked state machine (`lib/media/media-lifecycle.ts`, enum
  `MediaLifecycle`): `AWAITING_UPLOAD → UPLOADED → APPROVED | REVIEW |
QUARANTINED | REJECTED`, with `UPLOAD_FAILED` for expiry/abandon/reap
  (T14/AR4). Every new row is born `AWAITING_UPLOAD` (fail-closed); the only
  state that can serve bytes is `APPROVED` (and only with `!hidden &&
deletedAt == null` — `lib/media/serve-gate.ts`).
  `lib/media/moderation-status.ts` is removed; the serve gate and promote
  decision are consolidated on the new machine. Migration:
  `20260705083217_t14_presigned_upload_lifecycle_consolidation`.

### Added

- **Presigned direct-to-S3 upload flow for video (T14).** New presigned
  upload-session endpoints (`lib/routes/upload-sessions.ts`,
  `lib/presigned-upload-handler.ts`): the client uploads straight to a
  per-session `pending/{tenantId}/{sessionId}` staging key under a
  POST-policy grant confined to the exact key, MIME type, and a
  `content-length-range` byte rail (`lib/media/presign-policy.ts`).
  Completion HEAD-verifies the staged object and can never advance the media
  row past `UPLOADED` — verdicts belong to the moderation pipeline alone.
  `UploadSession` gains a `kind` discriminator (`legacy` | `presigned`) plus
  presigned-only columns. Contract:
  `apps/api/src/lib/doc/presigned-upload-contract.md`.
- **AR8 graph query hardening.** `getCircleStatus` rewritten as a UNION of
  two indexable branches with a 7-day floor and a 100-row cap;
  `computeSharedConnections` drops the recursive CTE for two bounded
  expansion levels; `getRelationships` and the home feed move to composite
  keyset cursors (`(score, targetId)` / `(createdAt, id)` — boundary ties no
  longer skipped); score sweeps become one `UPDATE … FROM unnest` instead of
  N per-row UPDATEs; a per-user relationship-edge cap is enforced at
  `createRelationship`; the enum-era `er.type::text` casts are dropped. All
  rewrites row-equality-proven; the graph suites run in the graph lane with
  live coverage for every touched adapter.

### Fixed

- **Quota byte-accounting race in presigned completion (AR-SEC F1, Medium).**
  `completeSession` persisted the HEAD-verified object size only when its own
  lifecycle transition fired; when the S3 worker won the bytes-arrived race
  the row kept the client-declared size forever, under-counting the storage
  quota (`_sum: size`). The authoritative size is now persisted
  unconditionally (idempotent separate update).

## [0.16.0] — 2026-07-05

### Removed

- **The legacy `friends` subsystem is deleted — friendship now lives in the
  Postgres relationship graph (breaking).** The Cloudflare-era
  `FriendsHandler` (KV-backed via the DynamoDB shim: `FRIENDS_KV` /
  `CONNECTION_CODES_KV`) duplicated the real social graph in the
  `relationships` edge table. `lib/friends-handler.ts`,
  `lib/routes/friends.ts` (every `/api/friends*` endpoint), and both KV
  bindings are removed; the Prisma-backed `/api/connection-codes` flow is the
  one connection mechanism. The friend definition is now the convergence
  contract in the new `lib/friend-ids.ts`: a _friend_ of a user is the target
  of an outgoing user→user `relationships` edge with circle **tier ≤ 1**
  (explicit `code`/`import` connections; passive tier-2
  `suggestion`/`discovery` edges do not count). Feed visibility filtering and
  entity-tagging validation resolve the friend set from the edge table.
  **Client handoff:** clients still calling `GET /api/friends` (e.g. the
  skybber Flutter friends datasource) must repoint to
  `/api/connection-codes` + the relationships surface. See
  `doc/02-technical/database/schema-endstate-2026-07.md`.

### Changed

- **Pre-launch schema end-state pass (breaking; pre-launch window, nothing
  live).** The AR10 prune drops every dormant zero-reference field cluster
  (User Border-Safety prep, Post/PostComment classification columns, MediaFile
  AT-Protocol `cid` + reconciliation bookkeeping, DirectMessage E2E-encryption
  prep, and the dormant `IngestState`/`UserEncryptionKey` models) and prunes
  indexes on hot tables (posts 17→7, users 16→2, media_files 16→7) — each
  drop/keep justified inline in `schema.prisma`. `EntityRelationship.type`
  changes from a Postgres enum to `String`: the edge vocabulary is dog-domain
  vocabulary and must not be baked into the domain-agnostic core as a DB enum;
  enforcement stays in app code (same pattern as
  `InteractionEvent.interactionType`).

- **All 14 accumulated pre-launch migrations are deleted and replaced by a
  single clean `20260705050826_init` migration** (+ the restored data-only
  `20260705051500_seed_role_metadata`, which now includes the MODERATOR row).
  The init migration creates the `postgis` + `pg_trgm` extensions, the graph
  edge tables (`relationships`, `entity_relationships` — previously created by
  **no** migration; the graph CI lane papered over it with `db push` and now
  runs `migrate deploy`), and the hand-written GiST/GIN/partial-unique
  objects. Existing dev databases must be reset (`migrate deploy` onto a fresh
  PostGIS Postgres); prod bootstrap is documented in
  `doc/02-technical/operations/prod-db-bootstrap-runbook.md`.

### Added

- **Schema-drift CI guard.** A new `schema-drift` job
  (`apps/api/scripts/check-schema-drift.sh`) applies `prisma/migrations/` to a
  scratch PostGIS Postgres and diffs the result against `prisma/schema.prisma`
  (`prisma migrate diff --script`); any unexplained difference fails CI, with
  the six known hand-written migration objects allowlisted. After the init
  lock, schema and migrations move in lockstep or the build goes red.

- **Daily AI-spend guard for the media-processing worker (AR5).**
  `lib/media/spend-guard.ts` adds a `MediaSpendGuardPort` capability seam plus
  a pure cost-estimation core, wired into `media-processing-worker`: before
  starting paid AI jobs (video moderation, transcription) the worker consults
  a consuming-app-provided daily spend counter and stops new jobs at the cap.
  The daily cap and per-minute rate are **runtime config** (Env/SSM via
  `MediaSpendConfig`), never literals in the public tarball. Fail-closed
  posture: an unreadable counter or a non-finite value blocks jobs
  (retry/DLQ), invalid estimation inputs throw rather than under-estimate, and
  a cap of 0 is an operator emergency stop; only _absent_ config disables the
  guard.

### Fixed

- **Whitespace-only post/comment text now fails closed with `400` instead of
  `500` (H1).** The create/edit post and create/edit comment schemas apply
  `.trim()` **before** `.min()/.max()`, so whitespace-only text (`"   "`,
  `"\t"`, `"\n"`) fails length validation at the handler boundary instead of
  passing `min(1)`, being trimmed to `""` downstream, and 500-ing. Nothing is
  persisted; property + example tests pin the behavior at both the schema and
  handler boundaries.

## [0.15.1] — 2026-07-04

### Fixed

- **Declared five runtime dependencies the shipped code imports but
  `package.json` never listed — one of which broke API-container boot on
  0.15.0.** `dist/lib/cognito/issuer-probe.js` imports `undici` (the
  DNS-rebinding-pinned dispatcher for the OIDC issuer probe); until 0.14.0
  the package resolved only because another dependency happened to pull
  `undici` in transitively, and 0.15.0's `@fedify/fedify` 2.3.1 update pruned
  that transitive edge — so a consumer's fresh `npm install` produced a tree
  where the server fails at startup with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'undici'`. Now declared
  (`undici@^8.5.0`), along with the other phantom imports found by a scan of
  the published `dist`/`src/lambda`: `@js-temporal/polyfill@^0.5.1`
  (`post-service-fedify`/`dm-service-fedify` — fedify 2 vocab objects take
  `Temporal.Instant`), and — moved from `devDependencies`, where they were
  invisible to consumers — `@aws-sdk/client-cost-explorer@^3.1078.0`
  (`lambda/tools/get-cost-report`), `@aws-sdk/client-ecs@^3.1078.0`
  (`lambda/tools/describe-services`), and
  `@aws-sdk/client-bedrock-agent-runtime@^3.1078.0`
  (`lambda/diagnostics-proxy`), since `dist` and `src/lambda` ship in the
  tarball and consumers bundle those Lambda entrypoints from
  `node_modules`. `@prisma/client` remains an intentionally undeclared
  _runtime_ dependency — it is a `peerDependency` by design (AR14). No API
  changes; the public export surface is untouched.

  (A local scan had also flagged `neo4j-driver`/`@smithy/*`/`@aws-crypto/*`
  imports in `dist/lib/graph/neo4j-graph-service.js` + `neptune-auth.js` —
  those were stale incremental-`tsc` outputs of sources deleted in the
  Postgres graph migration, present only in unclean local checkouts. The
  published tarball is built from a clean CI checkout and never contained
  them; nothing ships or imports Neo4j/Neptune code.)

## [0.15.0] — 2026-07-04

### Fixed

- **Text moderation now fails closed to ENABLED (AR-SEC T4 / F1).** The text
  moderation gate on post/comment create+edit was only invoked inside
  `if (moderationEnabled)`, where `moderationEnabled` came from
  `FeatureToggleService.isEnabled("content_moderation_enabled")`. That read is
  fail-_soft_: a missing/unseeded toggle row **and** any `feature_toggles`
  read error both resolve to `false`, so an unseeded environment — or a brief
  toggle-DB outage — silently skipped moderation per request while posts still
  wrote. Combined with the seed defaulting the flag to `false`, the whole
  fail-closed gate was dead until someone flipped it. The four moderated call
  sites now read the flag through a new
  `FeatureToggleService.isEnabledFailClosed(...)`, which resolves a missing row
  or a read error to `true` (moderate); only an explicit `enabled: false` row
  disables — the deliberate dev/test escape hatch. The seed default for
  `content_moderation_enabled` is flipped to `true`. `isEnabled` and
  foundation's fail-soft semantics are unchanged — every other (default-off)
  flag is unaffected. (Image/video media moderation was already unconditional —
  it is not feature-toggle gated — so it never shared this gap.)

- **Un-implemented queue workers now fail closed instead of silently acking.**
  The stub SQS workers (`link-check`, `followers-events`, `federation-outbox`)
  previously logged each record and returned successfully, deleting real
  messages from their queues with zero operational signal — for `link-check`
  this silently disabled a live security control (async link threat-intel
  checks enqueued on post/comment creation). Each stub now throws, so batches
  retry and dead-letter onto the DLQ where the consumer's DLQ alarm pages. The
  `federation-outbox` worker is feature-guarded: it throws only when
  `ACTIVITYPUB_ENABLED === "true"` and stays inert (warn + drop) when
  federation is disabled, matching the platform's fail-closed federation
  default. Deployments that enable federation must set
  `ACTIVITYPUB_ENABLED=true` on the federation-outbox worker's environment.
  (The fourth stub, `media-reconciliation`, is removed entirely together with
  its only producer — see the batch-upload cas/-bypass entry below — so
  deployers must also drop its queue/worker wiring.)

### Removed

- **Batch upload no longer bypasses moderation — the legacy direct-to-`cas/`
  upload path is deleted (breaking, internal).** `POST /api/media/upload/batch`
  used to write bytes straight to the approved `cas/{tenant}/{hash}` prefix via
  `MediaUploadService` with **no moderation verdict and no video re-encode**,
  then enqueued to the stub media-reconciliation worker (which silently acked) —
  violating the core media-safety invariant that `cas/` holds only approved,
  cleaned bytes produced by the moderated pipeline (stage → moderate →
  promote-on-APPROVED). The serve gate kept those bytes unservable, so this was
  a latent landmine rather than an active leak, but the invariant was false and
  batch uploads never became visible anyway. The route now returns
  `501 Not Implemented`; `MediaUploadService`, the media-reconciliation queue
  producer/consumer/service/types, the stub `media-reconciliation-worker`
  Lambda entry, and the `MEDIA_RECONCILIATION_QUEUE` env binding are deleted.
  Every remaining `cas/` write is gated on an APPROVED verdict (sync-image
  promote, completion-worker promote). Batch semantics, if wanted post-beta,
  will be rebuilt on the presigned direct-to-S3 upload flow. **Internal
  breaking notes for deployers:** the `dist/lambda/media-reconciliation-worker`
  bundle entry no longer exists (remove the worker + queue from infra and
  reclaim its reserved concurrency), and `Env` no longer has
  `MEDIA_RECONCILIATION_QUEUE`. Nothing on the public package API
  (`startServer`, `registerExtension`, provider seams) changed.

### Changed

- **Session key derivation is now cached at module scope (AR9 perf fix).**
  `SessionManager` is constructed per request (~160 call sites), so its
  previous instance-level `SessionCookie` cache never got a warm hit and every
  cookie-authenticated `getSession`/`encryptSession` re-paid the full
  600,000-iteration PBKDF2 (~65 ms locally, ~100–250 ms on Fargate vCPU; twice
  on the primary+fallback rotation path). The derived-key cache now lives at
  module scope keyed by the exact (secret, fallback-secret, salt) triple, so
  the KDF runs once per distinct secret per process instead of once per
  request (~1,200× faster warm `getSession` in the micro-benchmark). Rotation
  semantics are unchanged and covered by new tests: a rotated config is a new
  cache key (both new keys derived and cached; a stale pre-rotation key is
  never served), and the cache is bounded (FIFO, 32 entries). No public API
  change; no crypto parameter (iteration count, cipher, key size) changed.

- **`@prisma/client` is now a `peerDependency` (was a regular `dependency`).**
  `@de-otio/trellis` ships `dist` compiled against its own Prisma client, but
  a consuming application generates its own client from the schema shipped in
  the tarball with the consumer's own `@prisma/client`/`prisma` pins — the two
  can silently drift apart with no install-time signal. Declaring the peer
  range (`^7.8.0`) makes npm enforce alignment at install time instead. **This
  is a semver-relevant, consumer-facing change**: an application that was
  relying on `@de-otio/trellis` to pull in `@prisma/client` transitively must
  now depend on a compatible `@prisma/client` version itself (most consumers
  already do, since they run their own `prisma generate` against the shipped
  schema). The consumer-install smoke test (`apps/api/scripts/smoke-pack.sh`)
  now asserts the installed `@prisma/client` version satisfies this peer
  range as part of its tarball verification.

### Fixed

- **GDPR account deletion now actually erases the user's media** (AR7). Both
  account-deletion paths (the delete-account worker and the nightly scheduled
  cron) deleted the S3 prefix `originals/user-{id}/` — a scheme that no longer
  exists under tenant-scoped content-addressed storage
  (`cas/{tenantId}/{contentHash}`), so account deletion removed **zero media
  bytes**, a GDPR Art. 17 erasure gap. Media erasure now happens inside
  `deleteUserData`: every `MediaFile` row uploaded by the user is either
  **soft-deleted into the existing nightly GC purge** (which hard-deletes the
  row and its CAS bytes within its bounded 7-day window) when nothing else
  references it, or **retained with the personal link (`uploadedBy`) scrubbed**
  when another user's post/comment still references the deduplicated row — so
  erasure can never destroy another user's published content. The
  "still-referenced?" determination uses the single shared storage-accounting
  object-state predicate (`lib/media/storage-accounting.ts`: a CAS object is
  unreferenced iff no live `(tenantId, contentHash)` row remains; live =
  `deletedAt IS NULL`, the same predicate the upload quota counts). The
  user-scoped staging objects (`pending/…`, `processing/…`), which the GC purge
  does not track, are deleted directly by the calling worker via a new chunked
  batch-delete helper that structurally refuses `cas/*` keys. `DeletionResult`
  gains `mediaFilesErased`, `mediaFilesRetainedShared`, and `mediaStagingKeys`.

### Security

- **Invitation gate now fails closed when the `INVITATIONS_KV` binding is
  absent or erroring.** Previously, invitation session-token validation
  returned `valid: true` when the KV binding was missing ("backward
  compatibility"), so a misconfigured deployment silently disabled the
  invite-only gate — a fail-open on the front door. Now: a missing binding
  rejects session-token validation and invitation validation (generic
  `Invalid or unavailable invitation code`, no internals leaked, and without
  claiming/burning the code), a KV read error during token verification also
  rejects, and `storeSessionToken` throws instead of silently issuing a token
  that could never be verified. The failure mode is **visible-closed, not
  silent-closed**: every rejection logs a loud `SECURITY:`-prefixed error, and
  `validateEnv()` now refuses startup when `INVITATIONS_KV` is missing (it is
  always constructed by `buildEnv()`, so this only fires for a hand-built or
  miswired `Env`). Also removed the dead, never-called
  `createFriendshipFromInvitation`/`addToFriendsList` private helpers from the
  invitation handler (friendship from an invitation is user-confirmed via the
  friends handler).
- **Stale-media reapers no longer delete in-flight video uploads.** Async video
  uploads are born `uploadStatus: "PENDING"`, and the two stale-upload reapers
  (the hourly cron and the scheduled media-stale-cleanup job) hard-deleted
  `PENDING`/`FAILED` rows older than one hour — deleting rows (and, in one
  reaper, the stored object) that were still inside, or had just cleared, the
  moderation pipeline. Both reapers now share a single reap scope
  (`lib/media/stale-media-reap.ts`): a row with **any** `MediaModerationJob` is
  never reaped, the abandonment window is far larger than the moderation
  pipeline's worst-case latency (env-overridable via
  `MEDIA_STALE_REAP_WINDOW_MS`), the scope is re-asserted atomically at delete
  time so a reaper cannot race the pipeline, and the object-store delete now
  skips rows whose storage key is not yet set. The consuming application's
  persistence adapters are expected to advance `uploadStatus` to its terminal
  `COMPLETE` when processing + moderation resolve (the reference adapters do so
  as of this fix). The broader consolidation of
  `moderationStatus`/`uploadStatus`/orphan flags into one lifecycle state
  machine is intentionally deferred to the presigned-upload rework.

### Security

- **Posting-flow text moderation is now fail-closed (T4).** Post and comment
  text (create **and** edit) is routed through the injectable
  `TextModerationProvider` seam instead of the legacy `ModerationHandler`,
  which failed **open**: on a moderation-API error, timeout, spent budget, or
  missing API key it returned `{ approved: true }` and let the content
  through. The new gate (`text-moderation-gate.ts`) enforces the media
  pipeline's invariant — only an affirmative `approved` verdict lets text
  persist: a positive flag (`quarantine`) rejects with `400 CONTENT_REJECTED`;
  `review`, an unknown decision, a provider throw, or an un-wired seam yields
  `503 MODERATION_UNAVAILABLE` and the content is **not** persisted (and
  therefore never served). Consuming apps inject their concrete hosted-API
  adapter at startup via the new **`setTextModerationProvider`** export
  (mirrors `setMediaModerationProvider`); when unset, core degrades to a
  fail-closed `NullTextModerationProvider` (every verdict `review`) — an
  un-wired deploy holds text for review, never auto-approves, never 500s.

### Removed

- **`ModerationHandler` (`lib/moderation-handler.ts`).** The fail-open hosted
  moderation wrapper is deleted outright (pre-launch, no consumers): its
  error/budget/missing-key paths all manufactured `approved: true`. The hosted
  moderation call now lives in the consuming app's adapter behind the
  fail-closed seam above. (`OpenAiBudget` and the health/admin budget
  endpoints are unaffected.)

### Added

- **Boot-time environment validation (fail fast on misconfig).** `startServer()`
  now validates the raw `process.env` against a Zod schema
  (`apps/api/src/env-schema.ts`) before constructing any AWS client or
  resolving any secret, and refuses to start with a message naming each
  missing or invalid key — misconfiguration that previously surfaced only as
  runtime 500s found via post-deploy e2e now fails the deploy at boot.
  Required in every stage: database config (`DATABASE_URL`, `DB_SECRET_ARN`,
  or the legacy `DB_SECRET_USERNAME/PASSWORD/HOST` triple), the session secret
  (`SESSION_SECRET` ≥ 32 chars or `SESSION_SECRET_ARN`), and the Cognito
  pool/client ids. Required in prod only (dev-only-overridable):
  `SESSION_SALT` and `MEDIA_THRESHOLDS_JSON` (the media-moderation gate —
  absent in dev it safely fail-closes every category to review, but a prod
  deploy without it is operator error). Optional keys are format-checked when
  set (numeric `MEDIA_*` caps, the `MEDIA_*_JSON` allowlists/presets,
  `MEDIA_CANONICAL_FORMAT`/`_QUALITY`, `ACTIVITYPUB_ENABLED` must be exactly
  `"true"`/`"false"`) — a malformed value that the runtime resolvers would
  silently replace with a dev default (or fail-close) is now a boot failure;
  the runtime fallbacks themselves are unchanged (defense in depth). A
  correctly configured environment boots exactly as before, and the public
  package API is unchanged. The larger `Env`-slicing refactor remains a filed
  follow-up (architecture-review §7.1); the Cloudflare-shim retirement stays
  deferred until the legacy router is gone.

- **`/health` now reports build provenance (`buildSha`).** The health response
  includes `buildSha`, read from the `BUILD_SHA` environment variable that a
  consuming app's CI stamps into the container image (a Docker build arg set
  to the image tag). Deploy pipelines can assert the field equals the tag they
  just built, making "the new code is actually serving" machine-checkable
  instead of inferred from a green rollout. `null` when unset (local builds).
- **`@de-otio/trellis-extension-api` 0.4.0 — structural DTOs for the extension contract (AR13).** New exported types `ExtensionEntity`, `ExtensionPost`, `ExtensionRelationship`, `ExtensionPaginatedResult`, `ExtensionCircleMember`, `ExtensionCircleTierStatus`, `ExtensionCircleEntityStatus`, `ExtensionGlanceItem`, `ExtensionVisiblePost`, `ExtensionEntityRelationship` (plus the `ExtensionNodeType`/`ExtensionCircleTier`/`ExtensionConnectionMethod` vocabulary). `ExtensionGraphService`'s relationship/circle query returns are now typed with these DTOs instead of `unknown`, and `ExtensionHooks.onPostCreated`/`onEntityCreated` receive `ExtensionPost`/`ExtensionEntity` instead of `any`. Core asserts at compile time that its internal types satisfy the DTOs (`apps/api/src/lib/extension-dto-contract.ts`) — a core field rename now fails the build before publish instead of breaking extensions at runtime. Prisma types remain core-internal and are not published. Discovery/recommendation result shapes stay `unknown` for now (follow-up).

- **Organization classification, feed decluttering by org category, and a public organization directory.** Tenants can self-declare what kind of organization they are (business, non-profit, community group, government, educational, or other — via a platform-curated category tree, `PlatformCategory`) independently of `TenantType`, which only ever described membership structure, not commercial nature. Feed views gain a second, independent filter axis alongside circle tier: viewers can exclude or isolate posts by an author's organization category (e.g. "no business posts," or "non-profits only"), denormalized onto `Post.authorOrgRootCategoryCode` for the same cheap, indexed filtering already used for region/sensitivity/content-category. A new opt-in directory (`TenantDirectoryProfile`) lets a classified tenant become searchable by name, category, and location; location precision is a named level (`EXACT`/`NEIGHBORHOOD`/`CITY`/`HIDDEN`), not a boolean — `CITY`/`HIDDEN` listings are structurally excluded from distance-sorted search (not just response-shaped) to close a triangulation vector where ranking order alone could otherwise leak an intentionally-imprecise location. See [Organization Classification & Directory](docs/concepts/org-classification-and-directory.md) and [Classify and List Your Organization](docs/guides/classify-and-list-your-organization.md). Self-declared only in this release — third-party verification (TechSoup, Haus des Stiftens) and AI-assisted category-suggestion are planned follow-ups; org-to-org relationships (membership/subsidiary) and cross-tenant resource-sharing grants are designed but deliberately out of scope for this release.

## [0.14.0] — 2026-06-30

### Added

- **Synchronous image moderation wired into the upload path.** The sync-image
  upload now follows **stage → moderate → promote-on-approve**: cleaned
  (re-encoded) bytes are written to a `processing/` staging key, the staged
  object is moderated via the injected `MediaModerationProvider.moderateImage`,
  and the bytes are promoted to the canonical `cas/` key **only** when the
  verdict is `approved`. A `review` or `quarantine` verdict leaves the bytes at
  staging and records the row `REVIEW`/`QUARANTINED`, so `cas/` only ever holds
  approved bytes and the APPROVED-only serve gate can serve them. Images now
  reach `APPROVED` through the provider rather than being recorded approved by
  default — the moderation seam was previously never called. The provider is
  injected at startup via the new `setMediaModerationProvider` export (mirrors
  `setRealtimeProvider`); when unset, the path degrades to a fail-closed Null
  provider (every verdict `review`), never auto-approving and never 500-ing.
  Moderation is **fail-closed throughout**: any provider throw or timeout is
  treated as `review` (no `cas/` write), and the injected provider owns all
  thresholds (none are compiled into the public tarball).

## [0.13.0] — 2026-06-29

### Fixed

- **No-audio video no longer pins forever in review.** A video with no audio
  stream (a silent clip, a screen recording, a GIF-style mp4) has nothing to
  transcribe, so the worker no longer starts a speech-to-text job that would
  fault and fail the AUDIO track closed to `REVIEW` permanently. The
  transcode seam now reports whether the cleaned output carries an audio
  stream (`TranscodeVideoResult.hasAudio`, from a probe of the produced
  bytes — never a guess); when it does not, the processing worker starts no
  transcription and records the AUDIO track as **vacuously approved** (no
  audio content ⇒ nothing to be unsafe) under a synthetic, non-referenceable
  job id, so the VISUAL completion fans in against a settled AUDIO decision.
  Fail-closed is preserved: this is a positive verdict on a track with no
  content, not approval-from-doubt — an errored or absent track still
  degrades the object to `REVIEW`.

## [0.12.3] — 2026-06-26

### Fixed

- **Read-after-write race in `custom:userId` minting.** The
  pre-token-generation trigger could emit an empty `custom:userId` when the
  user row was not yet visible on a brand-new signup (the first token minted
  before the row settled), conflating a transient race with permanent
  post-restore drift. A token with an empty `custom:userId` makes every
  downstream `where: { id: userId }` lookup miss (e.g. media-upload tenant
  resolution → 500) until re-auth. The null-user path now bridges the window
  with a bounded RDS retry, and an empty-`userId` cache entry is treated as a
  miss. Genuine drift still exhausts the budget and falls through to the
  sentinel exactly as before. Retry bound + delay are runtime config
  (`PRETOKEN_RDS_RETRY_*`), not compiled-in.

## [0.12.2] — 2026-06-26

### Fixed

- **`SessionManager.getSession` derives `userId` from `custom:userId`.**
  Companion to 0.12.1: the JWT-Bearer strategy in `SessionManager.getSession`
  (the path the media routes authenticate through) also returned the Cognito
  `sub` (a UUID) instead of the `custom:userId` claim (the Trellis `User.id`
  cuid). Media uploads still 500'd with "Tenant resolution failed" after
  0.12.1 because the cuid-keyed row lookup missed. Now prefers
  `custom:userId`, falling back to `sub` only for legacy tokens minted without
  the claim.

## [0.12.1] — 2026-06-26

### Fixed

- **JWT-Bearer `session.userId` is the `custom:userId` claim, not the Cognito
  `sub`.** `getSessionFromRequest`'s JWT-Bearer strategy returned the Cognito
  `sub` (a UUID), but `User.id` is a cuid and every handler looks the session
  user up via `where: { id: session.userId }`. JWT-Bearer requests therefore
  missed the cuid-keyed row — most visibly P0b media tenant resolution.
  Derive `userId` from `custom:userId` (written by the pre-token-generation
  trigger), falling back to `sub` only for legacy tokens.

## [0.12.0] — 2026-06-26

### Added

- **Media-moderation pipeline (P0a fail-closed serve gate + P0b dual-track
  async moderation).** Media becomes a first-class tenant-scoped resource
  with a moderation lifecycle, and bytes are served only after an explicit
  approval.

  - **Moderation lifecycle.** `MediaFile` gains a `ModerationStatus` enum
    (`PENDING` / `APPROVED` / `REVIEW` / `QUARANTINED` / `REJECTED`),
    defaulting to `PENDING` so every object is born fail-closed. A pure state
    machine (`moderation-status.ts`) owns the legal transitions; a CSAM hit is
    handled by a separate statutory provider and drives `REJECTED` from any
    state.
  - **Fail-closed serve gate (P0a).** `serveMediaByHash` serves bytes **only**
    when `moderationStatus === "APPROVED"` (and the object is not hidden /
    soft-deleted), for every viewer — there is no owner exception. Every other
    outcome (not-yet-approved, not-found, DB error) returns one byte-identical
    "not found" response so the endpoint cannot be used as a
    moderation-threshold oracle.
  - **Hardened image ingest (P0a).** Every uploaded image is re-encoded to a
    canonical raster format before hashing (the polyglot / zero-click defense)
    under a decompression-bomb pixel cap; EXIF/GPS is stripped and verified
    absent. The `gpsLatitude` / `gpsLongitude` columns and their geo-index are
    dropped (data minimization), and `metadataVisible` now defaults to
    `false` (private-by-default metadata).
  - **Dual-track async pipeline (P0b).** Video/audio uploads land in a
    `pending/` quarantine prefix (`PENDING`, hashing deferred). The
    processing worker transcodes-and-discards to a staging key, hashes the
    **cleaned** bytes, and starts two independent moderation tracks: a VISUAL
    track via the video-moderation provider and an AUDIO track via
    transcription → text moderation. A fail-closed fan-in
    (`combineTrackVerdicts`) yields `APPROVED` only when **both** tracks are
    decided and approved; a missing, errored, or uncertain track degrades to
    `REVIEW`, and a quarantine on either track dominates. The completion
    worker promotes the cleaned staging bytes to the served `cas/` prefix only
    on approval — served bytes always equal moderated bytes.
  - **Injected capability seams.** Core ships the interfaces
    (`MediaModerationProvider`, `TextModerationProvider`, `TranscodePort`,
    `TranscribePort`, `StoragePort`) plus a fail-closed Null provider and
    in-memory Mocks; the consuming application injects the concrete cloud
    adapters at startup. Core imports no cloud SDK. A startup guard refuses to
    run the Null provider outside dev.
  - **Single canonical CAS key scheme** (`cas/{tenantId}/{sha256}`), tenant-
    scoped dedup (`@@unique([tenantId, contentHash])`, never cross-tenant),
    and a dedup-safe upsert that never transfers ownership or resets
    moderation status on a dedup hit.
  - Operational parameters (duration cap, upload quota, per-category
    moderation thresholds, rate limits, canonical format) are `Env.media`
    runtime config — no thresholds are compiled into the published package.

## [0.11.0] — 2026-06-20

### Added

- **Realtime / server-blind settings sync + delivery safety floor.** A
  `RealtimeTransport` capability seam (poll default; a consuming app injects a
  concrete transport — e.g. AppSync Events — via the new `setRealtimeProvider`
  export, so core stays infra-agnostic). Server-blind `EncryptedUserSetting`
  store + `GET/PUT /api/settings/:namespace` and `GET /api/settings/changes`
  (opaque AEAD ciphertext, CAS versioning, offline-backfill cursor); a reserved
  `__keyring` namespace for the wrapped-DEK bundle. The notification delivery
  floor is migrated into `CalmDeliveryResolver` and now **enforces** blocked-
  sender and minor-protection drops (quiet-hours / preference behavior
  preserved), plus a best-effort content-free push hand-off. New
  `EncryptedUserSetting` and `BlockedUser` Prisma models. Operational thresholds
  are runtime config (`REALTIME_*` env vars); no compiled-in values.

## [0.10.7] — 2026-06-07

### Changed

- **BREAKING:** the entity feed route is renamed `/api/feeds/dog/*` →
  `/api/feeds/entity/*` (the handler already used `entityRef` / `getEntityFeed`
  internally; only the path was dog-named). Consumers update their feed client.
- Restructured documentation into a published `docs/` folder (Diátaxis
  sections, frontmatter-driven ordering). The repository `README.md` is now a
  thin pointer into `docs/`.

### Added

- This changelog.

## [0.10.0] — 2026-06-06

### Added

- Canonical, non-null, unique user handle as the identity primitive (S-CP2).

## [0.9.0] — 2026-06-05

Baseline release of the public Trellis package.

[Unreleased]: https://github.com/de-otio/trellis/compare/v0.22.0...HEAD
[0.22.0]: https://github.com/de-otio/trellis/compare/v0.21.2...v0.22.0
[0.13.0]: https://github.com/de-otio/trellis/compare/v0.12.3...v0.13.0
[0.12.3]: https://github.com/de-otio/trellis/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/de-otio/trellis/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/de-otio/trellis/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/de-otio/trellis/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/de-otio/trellis/compare/v0.10.7...v0.11.0
[0.10.7]: https://github.com/de-otio/trellis/compare/v0.10.0...v0.10.7
[0.10.0]: https://github.com/de-otio/trellis/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/de-otio/trellis/releases/tag/v0.9.0
