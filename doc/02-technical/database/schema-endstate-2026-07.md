# Pre-launch schema & API end-state pass — decision record (2026-07)

**Status:** executed on branch `feat/prelaunch-schema-endstate` (2026-07-05).
**Premise (confirmed by R, 2026-07-04):** nothing is live, the dev DB is fully
resettable, nothing needs backward compatibility. This was the one-time window
to get the Prisma schema, enum vocabularies, storage-key layout, and internal
API shapes to their correct end state and lock them with a single clean `init`
migration + a schema-drift CI guard. After the first beta user, every one of
these becomes a forever-migration.

## Decisions

### 1. friends vs relationships/circles — COLLAPSED into relationships

The Cloudflare-era `FriendsHandler` (KV-backed via the DynamoDB shim:
`FRIENDS_KV` / `CONNECTION_CODES_KV`) duplicated the real social graph that
lives in the Postgres `relationships` edge table. It was removed entirely:

- `lib/friends-handler.ts`, `lib/routes/friends.ts` (the `/api/friends*`
  endpoints), and both KV bindings are gone. The Prisma-backed
  `/api/connection-codes` flow is the one connection mechanism.
- **Friend definition** (the convergence contract, in `lib/friend-ids.ts`):
  a *friend* of `userId` is the target of an outgoing user→user
  `relationships` edge with circle **tier ≤ 1** (explicit `code`/`import`
  connections; passive `suggestion`/`discovery` tier-2 edges do not count).
- Feed visibility filtering (`feed-handler.ts`) and entity-tagging
  validation (`entity-tagging-validator.ts`) now resolve the friend set from
  the edge table. This is a single-hop Prisma read by design — the
  circle-tier graph queries proper (recursive CTEs, radius semantics) are
  owned by the AR8 workstream and were deliberately not touched here.
- The ActivityPub `FriendshipService` stubs are untouched (federation is
  disabled, fail-closed).

**Client handoff:** the skybber Flutter friends feature
(`lib/features/friends/data/datasources/friends_remote_data_source.dart`)
still calls `GET /api/friends` and `DELETE /api/friends/{id}` (the DELETE
never had a server route). It must repoint to `/api/connection-codes` + the
relationships surface.

### 2. AR10 — dormant-field & index prune

Every drop is justified inline in `schema.prisma` next to the surviving
indexes. Summary:

- **Dormant field clusters with zero code references, removed:** the User
  Border-Safety prep cluster (travelMode\*, panicActionConfig,
  encryptionKeyId, defaultContext, emailHash, messageRetentionDays,
  autoDeleteAfterDays), Post/PostComment classification columns
  (sensitivityLevel, ownerContext, screeningRiskLevel, contentCategory),
  PostGeoIndex.sensitivityLevel, MediaFile AT-Protocol `cid` +
  reconciliation bookkeeping (uploadBatchId, reconciledAt,
  reconcileAttempts, createdViaReconciliation), DirectMessage E2E-encryption
  prep (encryptedText, encryptionKeyId, encryptionAlgorithm, encryptionIV),
  and the whole dormant `IngestState` and `UserEncryptionKey` models.
  Principle: when Border Safety / E2E messaging is actually built it gets a
  designed-for-purpose schema, not speculative columns that cost writes now.
- **Index prune on hot tables** (posts 17→7, users 16→2, media_files 16→7,
  plus systematic sweeps elsewhere). Drop categories: (a) single-column
  indexes duplicating a `@unique`; (b) leading prefixes of surviving
  composite/unique indexes; (c) low-cardinality boolean/flag indexes never
  used as scan predicates; (d) indexes on pruned columns.
- Kept: everything with a real query path (each noted inline), e.g.
  `media_files.uploadedBy` (GDPR erasure deleteMany), `users.invitationId`
  (invitation-chain traversal), the sentiment pagination index (which also
  serves the aggregation and summary reads as a prefix).

### 3. MediaFile lifecycle-enum consolidation (AR4 §3.4) — DEFERRED to T14

`moderationStatus` + `uploadStatus` + hidden/orphaned flags remain separate.
**Rationale:** the presigned-upload rework (T14) redefines the upload-session
states anyway; consolidating now would design the state machine twice. The
handoff note already lives in `lib/media/stale-media-reap.ts` and is now also
recorded here and in the schema comment on MediaFile. The invariants that any
future consolidation must preserve (all already enforced today):

- `cas/` holds only APPROVED cleaned bytes (staging lives under `pending/` /
  `processing/`; promotion happens only on an APPROVED verdict);
- serve-gate = `APPROVED && !hidden && !deletedAt` (`lib/media/serve-gate.ts`,
  fail-closed, no owner exception);
- every new MediaFile is born PENDING (fail-closed).

What *was* cleaned now (cheap, orthogonal to T14): the dead reconciliation
columns and `cid` (see AR10 above), and the schema comments now point at
`lib/media/cas-keys.ts` as the single canonical key scheme
(`cas/{tenantId}/{sha256}[/thumbnail|/optimized]`, `pending/{tenantId}/{uploadId}`,
`processing/{tenantId}/{sha256}`).

### 4. Enum vocabularies & storage-key layout

- **`EntityRelationship.type`: Postgres enum → String.** The edge vocabulary
  (PACK_MATE, SIBLING, PLAYMATE, PARENT, OFFSPRING, WALK_BUDDY) is
  dog-domain vocabulary and trellis is the domain-agnostic core. A
  vertical's vocabulary must not be baked into a core DB enum (every other
  vertical and every vocabulary change would need an `ALTER TYPE`
  migration). Enforcement stays in app code — the hand-written union in
  `lib/graph/types.ts`, the allowlist in `entity-relationship-handler.ts`,
  and the fixed traversal set in `lib/graph/postgres/discovery.ts` (whose
  raw SQL already compared via `type::text`). Same deliberate pattern as
  `InteractionEvent.interactionType` and `MediaModerationJob.decision`.
- **Everything else reviewed and left alone:** `PostRadius`
  (WHISPER/NORMAL/LOUD/SHOUT — correct; there is deliberately no
  `visibility` column), `EntityRelationshipStatus`, `ModerationStatus`,
  `UserRole`, tenancy enums, `ConsentPurpose`, safety enums
  (AgeTier/ProfileVisibility/DmAccess), `VerificationSource`,
  `LocationPrecision` — all generic and in use. `uploadStatus` stays a
  String pending T14.
- Storage-key layout was already correct post-D18 (`cas-keys.ts`); only the
  stale schema comments (`/thumb`, `/opt`) were fixed.

### 5. Drift review of the old migrations

- Graph edge tables (`relationships`, `entity_relationships`) existed only
  in `schema.prisma` — created by **no migration** (the CI graph lane used
  `db push` to paper over it). Fixed: they ship in the init migration; the
  graph lane now runs `migrate deploy`.
- The role-metadata seed predated the MODERATOR enum value and was never
  extended — the restored seed migration adds the MODERATOR row.
- Hand-written SQL carried over (documented in the init migration and
  allowlisted in the drift guard): `postgis` + `pg_trgm` extensions,
  `consent_cross_region_key` and `feature_toggles_key_global` partial
  uniques, the entity_location GiST index, the two trgm GIN indexes, the
  directory-profile expression GiST index.
- Two further hand-written objects were added after the lock, in
  `20260904130100_consent_third_party_columns_and_key` (also allowlisted in
  the drift guard): `consent_third_party_sharing_key` — a partial unique
  index on `(user_id, grantee_client_id, subject_entity_id)`
  `NULLS NOT DISTINCT` where `purpose = 'THIRD_PARTY_DATA_SHARING' AND
  active` — and `consent_third_party_sharing_shape_check`, a CHECK
  constraint making the grantee id, its issuer, at least one granted scope
  and an expiry mandatory on sharing rows.

## The lock

- **Single clean init migration** `20260705050826_init` (+ data-only
  `20260705051500_seed_role_metadata`), generated from the final schema on a
  fresh Postgres. All 14 accumulated pre-launch migrations deleted.
- **Schema-drift CI guard** (`.github/workflows/ci.yml` job `schema-drift`
  running `apps/api/scripts/check-schema-drift.sh`): applies the migrations
  to a scratch PostGIS Postgres and diffs against `schema.prisma`; fails on
  any unexplained difference, with the six hand-written objects allowlisted.

## PostGIS placement (prod RDS)

`CREATE EXTENSION IF NOT EXISTS postgis` stays **inside the init migration**.
Per AWS docs, PostGIS is *not* in the RDS trusted-extension list (which
covers `pg_trgm` etc. — installable with mere `CREATE` privilege on PG13+),
so it requires `rds_superuser`; installing it is documented as connecting
"as a user that has rds_superuser privileges … if you kept the default name
… you connect as postgres" (the master user). skybber's migrations run as
the RDS **master user** (the ECS migration task builds `DATABASE_URL` from
the RDS master secret — `scripts/deploy.sh`; `infra/lib/stacks/data-stack.ts`
uses `rds.Credentials.fromSecret(dbSecret)`), so in-migration creation works
on prod RDS. **Contingency:** if migrations are ever moved to a
least-privilege role, move the extension creation to the master-run
bootstrap step in the prod runbook.

Citations:
- <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.Extensions.html>
  ("PostgreSQL trusted extensions" list — includes pg_trgm, does **not**
  include postgis)
- <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Extensions.html>
  ("For RDS for PostgreSQL version 13 and higher versions, users (roles)
  with create permissions on a given database instance can install and use
  any *trusted extensions*")
- <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.PostGIS.html>
  (PostGIS setup: "connect … as a user that has rds_superuser privileges")

## Pre-existing failures noted (NOT from this pass)

Both reproduce identically on untouched trellis main @ `1014a52`:

- `test/unit/post-editing.property.test.ts` — Property 5 fails on
  whitespace-only edit text (`" "` → 500, expected 200).
- `test/integration/post-create-radius.integration.test.ts` — file-level
  failure under the default vitest config (needs a live DATABASE_URL; the
  default config points at a fake URL). Candidate for the config's
  integration-exclude list.
