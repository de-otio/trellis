# Security review remediation — handoff (2026-11-05)

Branch: `claude/youthful-goldberg-c18bkg` (base `30251d0`). Finding IDs refer to
the 2026-11-05 Trellis security review (`Trellis Security Review.md`, kept by the
owner outside the repo). First pass paused at the 08:59 CET time-box; a second
pass worked the Low/Info items and the gaps in M13/M14 once the review text was
in hand.

## Verification done

- `npm run lint` (tsc --build + gate-polarity) — clean.
- `npm test` — 12632 passed, 4 failed on first run (post-confirmation H5
  fixtures, magic-link M7); all 4 fixed. Full re-run: 12636 passed, 0 failed.
- **Not run:** standalone, testkit, graph, schema, integration lanes, smoke-pack
  (no Docker daemon/Postgres in the session).

## Fixed in this branch

| ID | Change |
|---|---|
| H1 | `routes/dashboard.ts` PATCH: self-modification refused; role changes need SUPER_ADMIN; non-SUPER_ADMIN cannot touch a SUPER_ADMIN target; claims-cache invalidation after the write; best-effort audit event (`dashboard.user.update`, no IP/UA). Tests added. |
| M9 (part) | `SessionManager.revokeAllSessionsIfBound` (no-op when no blocklist KV bound, throws if `SESSION_BLOCKLIST_REQUIRED=true` or the write fails). Wired into `UserDeprovisioning.suspendUser` (security event still written, then the call fails) and dashboard PATCH `status: "suspended"` (500 + "retry" on failure). `authMiddleware` (~32 route files) now honours the blocklist and epoch too — see the M9 (revocation) row. |
| M9 (revocation) | Found: the blocklist/epoch were read ONLY by `SessionManager.getSession`; `authMiddleware` (~32 route files) checked neither, so a suspension epoch bump and any blocklist logout were invisible there. Fix: shared `auth/revocation.ts` (key formats, KV resolution, readers) used by BOTH paths; `authMiddleware` now denies a blocklisted token and a JWT whose `iat` is at or before the user's epoch. `iat` added to `TrellisClaims` (golden updated). Same posture as `getSession`: no KV bound ⇒ allow unless `SESSION_BLOCKLIST_REQUIRED=true`; KV read failure ⇒ deny. New `POST /auth/logout` (+ `/api/auth/logout`): requires a valid session, blocklists the presented token, clears the cookie, 204 only if the write persisted. |
| H2 | `reaction-handler.ts` comment add/remove/get: `findFirst({id, tenantId})` + `canReadPost`, uniform 404; `routes/sentiments.ts` comment GET requires session + active tenant, `private, no-store`. |
| H3 | `media-handler.ts`: entity-avatar ownership heuristic removed; ownership = `uploadedBy === userId`; hide/unhide/delete/metadata-visibility use `requireUploader`; EXIF only for uploader. Optional `tenantId` check added. |
| H4 | `upload-session-handler.ts`: unowned ids rejected, canonical ids, cap `UPLOAD_SESSION_MAX_MEDIA_IDS` (default 50), `uploadedBy` filter on complete/abandon `updateMany`; `workers/hourly-cron.ts` soft-delete has `posts: { none: {} }`. |
| H5 | `identity/provision-confirmed-user.ts`: lookup by `subject` only; email collision (federated, or different subject) throws `ProvisioningIdentityConflictError` before any write; domain-based org-tenant membership requires `identityProviderName === tenant.cognitoIdpName`. |
| H6 | `session-cookie.ts` ignores `custom:role`, DB role wins on JIT; `auth/cognito-jwt.ts` no longer folds `custom:role` into `globalRole`; `tenant/idp-handler.ts` rejects `custom:*` attribute-mapping keys except `custom:idpGroups`. |
| M1/M2 | `getEntityProfile`: caller region only, `findFirst({id, tenantId})`, any ACTIVE owner, `followers` treated as private for non-owners. `getRelatedContent`: `canReadPost` gate (404), tenant + `buildPostAudienceFilter` on related posts; route returns generic error messages. |
| M3 | `post-handler.ts` INVALID_MEDIA response no longer includes the cross-owner diagnostic. |
| M4 | Link reports deduped per (reporter, resource); auto-block counts distinct reporters; `DOMAIN_AUTOBLOCK_REPORT_THRESHOLD`, `LINK_REPORT_RATE_LIMIT_PER_HOUR` env (defaults 5 / 10). |
| M5 | Deletion confirm: constant-time compare, attempt counter (`DELETION_CONFIRM_MAX_ATTEMPTS`, default 5) that burns the code, per-user rate limit on the confirm route. |
| M6 | `server.ts` sets internal `x-trellis-remote-addr` from the socket (client copy stripped); `trustedClientIp` uses it in `none` mode; `getRateLimitKey` uses `trustedClientIp`. |
| M7 | Magic-link unknown user returns a decoy `session` handle on Cognito. |
| M8 | Compiled-in `*.pages.dev` CORS allow-list removed. |
| M10 | Issuer probe: `conf.issuer` must equal probed URL (`ISSUER_MISMATCH`); every discovered endpoint gets the issuer's egress checks. |
| M11 | Invitation redemption: `updateMany({ id, used: false })` + count check. |
| M12 | Extension config denylist extended + pattern `/(SECRET|PASSWORD|PRIVATE_KEY|_KEY$|TOKEN|KEK|CREDENTIAL)/i` unless `EXT_`-prefixed; boot now refuses pattern matches too (not just the explicit list), with an actionable message. |
| M13 | Inbound HTTP-signature verification let an UNAUTHENTICATED sender cause unbounded outbound work: every request dereferenced a sender-chosen `keyId` URL, and the only rate limit (`admitActivity`, per instance domain) ran AFTER verification succeeded. Also, any bad signature evicted the cached actor document and refetched it live, so garbage signatures naming a victim's `keyId` hammered that actor through us and kept its cache cold. Fixes: (a) `verifyInboxRequest` (shared by the user inbox, group inbox, DM route and remote-activity handler) first takes a per-trusted-client-address token from the shared bucket (`ACTIVITYPUB_INBOX_PREVERIFY_RATE_LIMIT`, per minute, default 120) — 429 over budget, 503 and fail CLOSED if the limiter is down; unknown address ⇒ one shared bucket with 10x headroom. (b) the evict-and-refetch is allowed at most once per `keyId` per `ACTIVITYPUB_KEY_REFRESH_COOLDOWN_SECONDS` (default 60, 0 disables; map capped at 2048 keyIds). |
| M14 | Group collections ignored `Group.privacy`. `GET /groups/:id/inbox` served every delivered activity (actor, object, target, audience) to anyone; `followers` served the member list and count, and `outbox` its activities, to anyone, for PRIVATE groups too. Now: inbox is admin/moderator-only (an AP inbox is owner-only — public groups too); followers/outbox are open for PUBLIC and members-only otherwise; every refusal is the same 404 as a nonexistent group; any failure establishing the caller's role refuses. Also `processGroupFollow` only refused PRIVATE — a FRIENDS_ONLY group admitted any remote actor — it now admits only PUBLIC (`!== "PUBLIC"`, so a future value fails closed). |
| X1 (discover floor) | `ctx.db.discover()` floored only `post` and `taxonomyTaxon`; `postTaxonomyTag` fell through to `{}` on the strength of a code comment saying the relation-where guard applied the post floor — it does not (it only checks that a traversed relation targets an allowed model). So findMany/count/groupBy returned and let an unauthenticated extension route probe the tags and `addedBy` user ids of private, hidden and soft-deleted posts. `postTaxonomyTag` now inherits the exact `post` floor through its `post` relation. `entityTaxonomyTag` / `productTaxonomyTag` still unfloored (see follow-ups). |
| X2 (test-route gate) | `testRoutesEnabled` read the prod marker from only the first of `STAGE \|\| DEPLOY_ENV`, so `STAGE=staging` + `DEPLOY_ENV=prod`, or the `buildEnv` default `STAGE=dev` hiding `DEPLOY_ENV=prod`, bypassed it. Now `STAGE`, `DEPLOY_ENV`, `NODE_ENV` and their raw `process.env` counterparts are ALL checked; any prod marker denies over every opt-in. **`CI=true` still enables the routes in non-prod stages** (deliberate, tested; changing it needs workflow edits, which are on the never-touch list). |
| X3 (dashboard DELETE) | `DELETE /api/dashboard/users/:id` let an INTERNAL operator schedule deletion of any account including a SUPER_ADMIN, with no audit. It now has the PATCH target rule (only SUPER_ADMIN may touch SUPER_ADMIN; 404 for a missing target) and a best-effort audit event. Does not yet revoke sessions / invalidate claims (see follow-ups). |
| X4 (tenant audit) | `GET /api/tenants/:id/audit` was readable by any tenant member including GUEST (actor ids, source addresses, 10k-row CSV). Now requires `Capability.AuditView` (ADMIN and above), same as the compliance export. **Behaviour change:** MEMBER/GUEST callers now get 403. |
| X5 (log redaction) | Removed from application logs: email, session id and client address from the rate-limit warning; client address from the SecurityMonitor info line and the whole event object from its no-webhook alert; Cognito `username` from the JWT-verified debug line; email from the e2e-sweeper messages; username and stringified error from the member sign-out warning; the redeemed connection code (now the row id); query strings from the three server error lines (magic-link tokens/emails can ride in them). |
| I1 | `POST /api/auth/discover`: ceiling is now runtime config (`AUTH_DISCOVER_RATE_LIMIT`, `AUTH_DISCOVER_RATE_WINDOW_SECONDS`, defaults 30 / 60, invalid values fall back), the email is bounded to 254 chars before the regex and DB lookup, and the dead client-IP variable is gone. Failure policy deliberately unchanged (the limiter's in-memory fallback still enforces the limit per process). |
| M13 (rest) | Per-TARGET-HOST bound on outbound key fetches (`ap:keyfetch:<host>`, `ACTIVITYPUB_KEY_FETCH_RATE_LIMIT`, default 30/min, fail closed) applied before every live fetch incl. the forced refresh; negative cache keyed on origin+path so a varying query/fragment/port/case no longer defeats it; key fetches restricted to port 443 (`ACTIVITYPUB_ALLOWED_FETCH_PORTS`, `*` lifts). |
| M14 (rest) | `GET /groups/:id` (actor document) returns the same uniform 404 to non-members for non-PUBLIC groups. |
| L1 | A federated Follow joins only a PUBLIC group (`!== "PUBLIC"`, fails closed on new values). |
| L2 | Inbox body capped (`ACTIVITYPUB_INBOX_MAX_BODY_BYTES`, default 256 KiB → 413, checked on Content-Length and on the verified bytes) in both inboxes; `to`/`cc`/`bto`/`bcc` capped (`ACTIVITYPUB_MAX_ADDRESSEES`, default 100 → 400; `storeInboxActivity` throws as a backstop). **Retention NOT done** (see below). |
| L3 | Canonical URIs come from `ACTIVITYPUB_BASE_URL` first; with federation enabled and a base URL set, a mismatched Host on federation paths gets 421 (`ACTIVITYPUB_ALLOWED_HOSTS` for proxies that rewrite Host) and `request.url` is rebuilt on the configured origin. |
| L4 | `GET /audiences/:id` is count-only for anonymous callers and signed-in non-members/non-creators (fail closed); creator and members still get items. |
| L5 | Public feature-toggle read no longer returns `changedBy`; its 500 is generic. |
| L6 | Post delete/edit/hide/unhide: "no such post" and "not yours" are the same 404 (tenant-isolation doc); with a verified Bearer tenant a cross-tenant post is the same 404 (wired opportunistically in `routes/posts.ts`). Collection entity targets are looked up with the collection's `tenantId`. |
| L7 | A remote Postgres host with no CA now throws unless `DB_SSL_INSECURE=true` (then the old unverified mode plus one warning). |
| L8 | Removed email / invitation code / IP / user-agent / `session.email` / debug `console.error` from the cited handlers; the entity delete path no longer logs the whole entity row (which included a private key). |
| L9 | Raw `error.message` no longer returned to clients from feed, taxonomy, taxonomy-analytics, products, media, audiences and admin handlers (status codes and response fields unchanged). |
| L11 | SMTP: credentials are never sent over a plaintext socket (pure `decideSmtpAuth`); without credentials nothing changes. |
| L13 (part) | Secret compares use `timingSafeEqual` over hashes; agent approval uses the session's ACTIVE tenant (membership verified) instead of the oldest membership. Dead flow left (see below). |
| L14 | MFA `enroll/finalize` is bound to `enroll/begin` via a sealed, expiring enrolment token (`MFA_ENROLL_TTL_SECONDS`, default 600) — a client-chosen secret/backup codes are rejected; the MFA cookie now goes through `SessionManager.setSession` (same attributes as login). |
| I2 (part) | `DEVICE_AUTH_KEK_BASE64` + `DEVICE_AUTH_KMS_KEY_ID` both set in production now refuses (warns in non-prod). The KV-cursor HMAC key part needs `env.ts` — not done. |
| I3 | `docker-compose.yml` (Postgres, DynamoDB-local, LocalStack) and `docker-compose.hatchet.yml` (dashboard, gRPC) publish on `127.0.0.1` only. |
| I4 | safe-fetch: unset `allowedPorts` means the scheme's default port only (delivery and key fetch share `ACTIVITYPUB_ALLOWED_FETCH_PORTS`); fetched keys must be RSA ≥ 2048 bits (`ACTIVITYPUB_MIN_RSA_BITS` can only raise); WebFinger not-found and suspended/deleted are byte-identical 404. |
| I5 | `POST /api/media/upload` rejects a declared Content-Length above max(image cap, video cap)+slack (`MEDIA_UPLOAD_MULTIPART_OVERHEAD_BYTES`) with 413 before parsing the body. Limit: an image can still be buffered up to the video cap. |
| Role-matrix guard | `test/unit/security/user-role-writers.test.ts` pins every code path that writes `User.role` (and every `createUser` caller that passes one). A new writer fails the build until reviewed. Also: `entity-handler` no longer seeds a new row's global role from the session (constant `END_USER`). |
| L8 (part) | Invitation code/email removed from redemption log lines. |
| L12 | `/oauth2/device_authorization` per-IP limit (`DEVICE_AUTHORIZATION_RATE_LIMIT` default 10 / `..._WINDOW_SECONDS` 60). |

## Behaviour changes a human must decide on / follow up

1. **H5:** `post-confirmation.ts` passes `identities[0].providerName`. The
   Keycloak JIT path sets `federated: false` by design (plan 016), so
   domain-based org-tenant JIT was never available there — not a regression.
   `ProvisioningIdentityConflictError` now carries a generic message (Cognito
   relays it to the client; a specific one is an enumeration oracle); on
   Keycloak the throw already fails closed to a 401. A native signup may
   still link onto a subject-less row with the same email (deliberate).
2. **H1:** done (see table).
3. **H3:** `tenantId` is deliberately NOT wired into the mutation paths: they
   already require `uploadedBy === userId`, and a multi-tenant user who
   uploaded under tenant A and acts under tenant B would get 404s on their own
   media. Decide whether defence-in-depth is worth that before wiring
   `resolveUploadTenantId` (`routes/media.ts`). List/stats code still reads
   `metadata.avatar` for classification (no mutation rights);
   `metadata.avatar` is not validated on entity write. Rows with null
   `uploadedBy` are now immutable.
4. **H4:** no tenant filter (session has no tenant); default cap 50 is a guess.
5. **M6:** with `TRUSTED_PROXY=none` behind a private-network proxy all clients
   share an `ip:unknown` bucket — deployments behind a proxy must set
   `TRUSTED_PROXY=alb|cloudflare`. Downstream consumers' deploy config should be checked.
6. **M12 (decided: refuse at boot):** `coreSecretEnvKeysIn` now uses
   `isCoreSecretEnvKey`, so a secret-shaped config key without the `EXT_`
   prefix refuses boot with a message naming the fix, instead of silently
   becoming `undefined`. **Upgrade note:** any extension declaring such a key
   (e.g. `*_API_KEY`) must rename it to `EXT_<NAME>` before taking this
   version. Documented in `docs/reference/extension-api.md`.
7. **M10:** discovered endpoints are DNS-checked once; Keycloak re-resolves later.
8. **M4:** no DB unique constraint (needs a migration) — concurrent duplicate
   reports possible.
9. New env vars to document: `UPLOAD_SESSION_MAX_MEDIA_IDS`,
   `DELETION_CONFIRM_MAX_ATTEMPTS`, `DOMAIN_AUTOBLOCK_REPORT_THRESHOLD`,
   `LINK_REPORT_RATE_LIMIT_PER_HOUR`, `DEVICE_AUTHORIZATION_RATE_LIMIT`,
   `DEVICE_AUTHORIZATION_RATE_WINDOW_SECONDS`, `ACTIVITYPUB_INBOX_PREVERIFY_RATE_LIMIT`,
   `ACTIVITYPUB_KEY_REFRESH_COOLDOWN_SECONDS` (the last two are documented in
   `docs/concepts/activitypub.md`; like the others they are read from
   `process.env`, deliberately NOT added to the `Env` type or its public API
   snapshot).

10. **Second-pass env vars** (all read from `process.env`; none added to `Env`):
    `ACTIVITYPUB_KEY_FETCH_RATE_LIMIT`, `ACTIVITYPUB_ALLOWED_FETCH_PORTS`,
    `ACTIVITYPUB_INBOX_MAX_BODY_BYTES`, `ACTIVITYPUB_MAX_ADDRESSEES`,
    `ACTIVITYPUB_MIN_RSA_BITS`, `ACTIVITYPUB_ALLOWED_HOSTS`, `DB_SSL_INSECURE`,
    `MFA_ENROLL_TTL_SECONDS`, `MEDIA_UPLOAD_MULTIPART_OVERHEAD_BYTES`.
11. **Operator-facing behaviour changes to check before deploying** (deployments
    that rely on the old behaviour will break at boot or on first request):
    - **L7** — remote Postgres without `DB_SSL_CA` / `DB_SSL_CA_PATH` now
      refuses to start unless `DB_SSL_INSECURE=true`.
    - **L3** — behind a proxy that rewrites `Host`, federation paths return 421
      until `ACTIVITYPUB_ALLOWED_HOSTS` is set (only when `ACTIVITYPUB_ENABLED`
      and a base URL are configured).
    - **I4/M13** — federation to hosts on a non-443 port needs
      `ACTIVITYPUB_ALLOWED_FETCH_PORTS`; peers with RSA keys under 2048 bits can
      no longer sign.
    - **L14** — MFA clients must send `enrollmentToken` (from `enroll/begin`) to
      `enroll/finalize`; a bare `secret`/`backupCodes` body now gets 400.
    - **L6** — non-owner post mutations return 404, not 403.
    - **L4** — remote servers fetching a custom-audience collection see the
      count only.
    - **L11** — SMTP with credentials but no TLS/STARTTLS now refuses to send.
    - **I2** — production with both a KEK and a KMS key id configured refuses.

## Not started

- **M9 follow-ups (not blocking):** cost is now 1–2 KV reads per authenticated
  request when a blocklist KV is bound (none when unbound) — watch KV latency
  and consider a short in-process negative cache if it shows. `iat` is in
  seconds, so a token minted in the same second as a revocation is rejected
  (re-login retry succeeds). Logout revokes only the presented token; a client
  holding both a cookie and a Bearer must send logout once per credential.
  `suspendUser` has no in-repo caller; member removal
  (`tenant/member-handler.ts`) uses Cognito global sign-out, not the epoch.
- **H3 (decided: don't wire `tenantId`)** — uploader check stays the sole gate;
  the optional `tenantId` seam on `getMediaDetails` stays unused.
- **M13 / M14 follow-ups.** Known leftovers:
  - M14: a PUBLIC group's outbox still lists every outbox activity regardless
    of its `to`/`cc` audience; filtering to public-addressed activities is not
    done.
  - M14: a signed federated GET from a remote peer is not accepted as
    authorization for a members-only collection or a private actor document (no
    authorized-fetch path), so peers cannot read non-public groups at all.
  - M14: `GET .../followers` and `.../outbox` still do `parseInt(page)` with no
    lower bound (a negative or non-numeric `page` reaches Prisma `skip`).
  - M13: the refresh-cooldown map and the nonce store are per process; the
    pre-verification and per-host limits use the shared token bucket, so they
    hold across replicas only when a shared limiter backend is configured
    (`KV_PROVIDER=postgres` or `RATE_LIMIT_TABLE`).
- **Second-pass items NOT done or only partly done:**
  - **L2 retention** — needs a scheduled prune of `activities` where
    `inbox_actor_uri IS NOT NULL AND received_at < now() - <retention>` (batched,
    env-configurable window) plus an index on `received_at`; that is a new
    migration and a cron job.
  - **I2 KV cursor key** — add a dedicated `KV_CURSOR_HMAC_SECRET` at `env.ts`
    (~1614); refuse to boot in prod if unset or equal to `SESSION_SECRET`.
  - **L13 dead flow** — `agent-authorize.ts` requires a `refreshToken` nothing
    seals and posts CSRF as a form field while the middleware reads a header, so
    it can never succeed. With the active-tenant fix it now additionally needs a
    verified `session.activeTenantId` (cookie sessions have none). Delete the
    HTML approval form, or rebuild it on the verified JWT.
  - **L14** — re-enrolling still needs only a session; nothing checks the
    existing factor was just verified before `finalize` replaces it.
  - **L6** — collection owner checks still answer 403 (not 404) for non-owners
    of a PRIVATE collection; same oracle class, outside the cited lines.
  - **L9** — ~45 lower-risk handlers still log whole error objects.
  - **Cross-tenant two-tenant fixture test** (every `:id` route driven with the
    other tenant's ids, asserting a uniform 404) — not written. Behavioural
    cross-tenant tests exist per fixed route; the generic driver does not.
  - **Structural note** — `TENANT_SCOPE_MODE=off` plus an inert RLS backstop
    means isolation rests on each handler's explicit `tenantId`; turning the
    ambient scope on (or `warn`) in the consuming deployment converts most of
    H2/M1/M2 to defence in depth. That is a deployment setting, not a code change.
- **Found by the audits, deliberately not applied (each needs a decision):**
  - `GET /api/admin/orphaned-media/health` and `/backlog` have no auth at all
    (`middleware: []`). Adding a staff-session gate may break unauthenticated
    monitors that poll it — decide the monitor credential first.
  - Presigned uploads: size is bounded and the post-upload HEAD re-checks it
    (SAFE), but nothing caps concurrent `awaiting-upload` sessions per user and
    quota is checked against the DECLARED size, not the real one. Fix needs a
    `media.*` config field (`env.ts` + API snapshot).
  - `GET /api/feature-toggles/:key` is public and returns `changedBy` /
    `lastChanged`, and its 500 path echoes `error.message`.
  - `authMiddleware` / `requireSuperAdmin` read `globalRole` / `tenantRole` from
    the verified JWT, not the DB, so a demoted admin keeps the role until token
    expiry (bounded by the M9 epoch only when a revocation was recorded).
  - `discover()`: `entityTaxonomyTag` / `productTaxonomyTag` unfloored; the
    `post` floor keys on the deprecated `radius` column and ignores
    `audienceClass`, `discoverability` and `groupId` (unclear whether
    `radius = SHOUT` can coexist with a non-public audience).
  - `push-dispatcher.ts` logs whole `err` objects in a loop over plaintext
    push tokens (plausible leak, unconfirmed); ~45 lower-risk handlers log whole
    error objects.
  - Dashboard DELETE does not revoke sessions or invalidate claims.
- **L10 — needs a human (workflows are on the never-touch list).** Suggested
  issue text: "`.github/workflows/dependabot-release.yml` (~117-120): one reusable
  workflow is referenced `@main` with `secrets: inherit` and `contents: write`,
  and is triggered when a commit message merely *contains* `dependabot[bot]`.
  SHA-pin the reusable workflow and match on `head_commit.author.username`
  instead of the message."
- Full CI lanes needing Postgres/DynamoDB (standalone, testkit, graph, schema,
  integration, smoke-pack) have not been run on this branch.
