# Security review remediation — handoff (2026-11-05)

Branch: `claude/youthful-goldberg-c18bkg` (base `30251d0`). Work paused at the
08:59 CET time-box. Finding IDs refer to the 2026-11-05 Trellis security review.

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
   `DEVICE_AUTHORIZATION_RATE_WINDOW_SECONDS`.

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
- **M13** AP keyId fetch amplification; **M14** private-group followers/inbox.
- **L1–L7, L8 (rest), L9, L11, L13, L14, I1 (auth-discover 30/min), I2, I4, I5.**
- **L10** (`.github/workflows/**`) and **I3** (compose binds) — workflows are
  on the never-touch list; open an issue for a human.
- Cross-tenant two-tenant fixture test and role-matrix test (review §"Test-coverage gap").
- Full CI lanes needing Postgres/DynamoDB.
