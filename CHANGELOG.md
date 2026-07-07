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
  contract in the new `lib/friend-ids.ts`: a *friend* of a user is the target
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
  a cap of 0 is an operator emergency stop; only *absent* config disables the
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
  *runtime* dependency — it is a `peerDependency` by design (AR14). No API
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
  fail-*soft*: a missing/unseeded toggle row **and** any `feature_toggles`
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

[Unreleased]: https://github.com/de-otio/trellis/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/de-otio/trellis/compare/v0.12.3...v0.13.0
[0.12.3]: https://github.com/de-otio/trellis/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/de-otio/trellis/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/de-otio/trellis/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/de-otio/trellis/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/de-otio/trellis/compare/v0.10.7...v0.11.0
[0.10.7]: https://github.com/de-otio/trellis/compare/v0.10.0...v0.10.7
[0.10.0]: https://github.com/de-otio/trellis/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/de-otio/trellis/releases/tag/v0.9.0
