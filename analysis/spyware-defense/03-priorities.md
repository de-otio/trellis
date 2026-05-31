# Prioritized Changes

Ordered by (impact × feasibility), highest first. Each item names the concrete file(s) to touch and what "done" looks like. Threat-class references (T1/T2/T3) are defined in [`01-threat-model.md`](01-threat-model.md).

---

## P0 — Wire up what already exists in the schema

These are finishing the job on dormant scaffolding, not new feature work.

### P0.1 Server-side EXIF and GPS stripping on media upload

**Impact:** High. User-uploaded photos are the #1 unintended-location-leak channel on any social product, and EXIF GPS leaks precise (±5m) coordinates to anyone who can read the media file — including any federated server that receives the post, any reposter, any DM recipient.

**Current:** Client uploads → S3 presigned PUT → media-processing Lambda (Sharp). `MediaMetadataExtractor` reads dimensions only. EXIF survives into S3 and into the served file. The `exifData`/`gpsLatitude`/`gpsLongitude` columns are populated if present and only hidden from rendering via a `locationVisible` flag that isn't enforced.

**Change:**
1. In the media-processing Lambda, call `sharp(...).rotate().withMetadata({ exif: {}, icc: undefined })` (or equivalent) so derivative files carry no EXIF.
2. For the *original*, either (a) strip in-place and re-upload, or (b) store the original encrypted with a per-user key and serve only derivatives to others. (a) is simpler; (b) is more robust for future forensic-resistance.
3. Stop persisting `gpsLatitude`/`gpsLongitude` to the DB unless the user explicitly opted into a location-tagged post. Populate from the post's chosen location, not from the photo.
4. Make `locationVisible` and `metadataVisible` actually gate the API response (they don't today).

**Files:** media-processing Lambda (in `apps/api/src/lambda/`), `media-metadata-extractor.ts`, MediaFile read handlers.

### P0.2 Coarsen location at write time based on `locationAnonymizationLevel`

**Impact:** High for T2 (subpoena) — a coarsened geohash is much less useful to a warrant than lat/lng to 6 decimals. **Also high for T4 (commercial data brokers)**: a 1km × hour-bucketed post is much harder to cross-reference against a MAID-keyed 3-year location corpus (e.g. Penlink's Webloc) than 6-decimal lat/lng at second precision. Location coarsening is a dual-purpose defense — subpoena-hardening *and* broker-correlation-hardening.

**Current:** `User.locationAnonymizationLevel` is `0` by default and unused. `PostGeoIndex.lat`/`lng` are written at full precision.

**Change:** At post creation, quantize lat/lng based on the user's level:

- `0` — off (current behavior)
- `1` — ~1km grid (3 decimal places)
- `2` — ~10km grid (2 decimal places) + drop precise geohash, keep `place` name only
- `3` — drop location entirely; `place` only if user-typed

Apply the same coarsening to the entity `lat`/`lng` used by the discovery graph. On the Neo4j side, the `POINT` property should already be coarsened; don't write full precision to the graph "just in case".

**Files:** post-creation handler, entity-creation handler, graph sync.

### P0.3 Turn on IP-address scrubbing in audit logs

**Impact:** Medium-high for T2. `SecurityEvent` is a prime subpoena target ("show me every IP for user X over the last 90 days"). Even reducing to a /24 (IPv4) or /48 (IPv6) kills targeted geolocation without losing anti-abuse signal. The April 2026 DHS/Reddit subpoena explicitly demanded "IP addresses" and "telephone model number(s)" as part of its shopping list — this is not a hypothetical category.

**Current:** `audit-logger.ts` stores `ipAddress` and `userAgent` verbatim. `rate-limit.ts:76` has a "TODO: IP scrubbing" comment.

**Change:**

- Before persisting to `SecurityEvent`, mask the IP to /24 or /48 except for a short retention window (e.g., 7 days of precise IPs for active abuse response, then auto-truncate via a cron).
- Replace User-Agent with a coarse bucket (`ios-app-1.x`, `web-chromium`, `web-safari`) rather than the raw string, which is a cheap fingerprint.

**Files:** `audit-logger.ts`, a new cron in `apps/api/src/lambda/` to roll up old rows.

### P0.4 Move ActivityPub private keys out of RDS

**Impact:** High if federation is ever enabled. A plaintext `privateKey` in the `User` table means a single DB read compromises every user's federated identity — someone could sign posts as any user on any federated server.

**Current:** `User.privateKey` is plaintext. No rotation.

**Change:**

- Store private keys in KMS (one CMK per stage, one data-key per user, envelope-encrypted in the DB), or in Secrets Manager keyed by user ID.
- Add a rotation Lambda that can mint a new keypair and publish the new public key to followers via `Update` activity.
- This is only load-bearing if/when ActivityPub is enabled (`config.features.activityPub`). If federation stays disabled, this becomes P2.

**Files:** `activitypub/http-signatures.ts`, user creation path, new KMS/Secrets wiring in ApiStack.

### P0.5 Message/media ingestion hygiene (zero-click surface reduction)

**Impact:** Very high against T3. This is the *specific* defense implied by the Graphite-via-WhatsApp pattern.

**Change:** Applied across post ingestion, DM ingestion, and ActivityPub federation:

1. **Narrow media allowlist.** Accept only JPEG, PNG, WebP (static), MP4/H.264, MOV/H.264. Reject HEIC, HEIF, AVIF, animated WebP, GIF, SVG, BMP, TIFF, and exotic container formats at upload and at federation-inbox ingest. The NSO `FORCEDENTRY` / `BLASTPASS` chains exploited iMessage's handling of exotic formats (PDF, WebP) — a boring allowlist is the defense.
2. **Transcode-and-discard.** For every accepted upload, transcode through Sharp/ffmpeg to a canonical JPEG/MP4 and serve only the transcoded derivative. The original bytes (which may carry an exploit payload) never reach a recipient's decoder.
3. **No server-side OG/link-preview scraping** from user-supplied URLs. If a preview is desired, generate it client-side on the sender's device before send (so server never emits an outbound fetch for a target-supplied URL, and the recipient never sees an embed from the attacker).
4. **Federation inbox hardening.** When `features.activityPub` is on, apply the same allowlist + transcode to inbound media from remote ActivityPub servers, and refuse `Content-Type`s outside the allowlist. Rate-limit `Activity` POSTs per remote host; quarantine `Create` activities from previously-unseen remotes for an async review queue.
5. **DM first-contact quarantine.** Messages from a sender not already connected via `ConnectionCode` or in the recipient's graph arrive in a "message requests" bucket on the client — no media auto-download, no link previews, no push delivery. This is the Signal / iMessage "Unknown Senders" pattern and it breaks a lot of drive-by delivery.

**Note:** even if trellis encrypts DM bodies E2E (P1.1), the *ciphertext* still has to be parsed by the client; zero-click exploits have historically lived in the pre-decryption parse (length-prefix, framing, image thumbnail the server generates for notification previews). So P0.5 and P1.1 are complements, not alternatives.

**Files:** post-creation handler, DM handler, media-processing Lambda, `apps/api/src/lib/activitypub/inbox-*` handlers, plus client-side policy in the mobile app (scope notes only — client work lives in the product repo).

### P0.6 Implement panic/lockdown mode

**Impact:** High for T1. A user who notices an abnormality (unexpected login, suspicious message, device lost) can revoke sessions and dramatically reduce what a compromised device can read.

**Distinct from BSM travel preparation.** Border Safety Mode (a product-repo feature; see the Border Safety Mode analysis in the product repo) is a sister feature for *planned, pre-travel* content remediation — review each item, approve, batch archive, restore later. P0.6 is for *unplanned, active-compromise* response — revoke sessions, hide recent-history exfiltration surface, no per-item approval. Different trigger, different scope, different UX. Both ship.

**Current:** The former `User.panicActionConfig` field from BSM v1 (dual-profile panic-wipe) is being removed (see the BSM implementation-status doc in the product repo) as part of BSM's v1 cleanup. P0.6 introduces its own fields rather than repurposing that one.

**Change:** Minimum viable lockdown:

1. Add `lockdownUntil: DateTime?` and optional `lockdownRecoveryEmail: String?` fields to the `User` model. No enum of "actions" — lockdown is the only mode; wipe is deliberately not offered (irreversible; if the user wants to remove specific content, that's BSM's job, not P0.6's).
2. A `POST /api/account/lockdown` endpoint that:
   - Revokes all Cognito tokens (Cognito `AdminUserGlobalSignOut`).
   - Sets `lockdownUntil` on the user.
   - During lockdown: DMs are hidden from API responses to the account owner, post-creation is blocked, historical posts older than N days are hidden from the user's own view (so a compromised device with a stolen session can't exfiltrate history). **Do not** globally hide the user's existing posts from other viewers — per BSM research, sudden-silence patterns (mass deletion, abrupt invisibility) are themselves flagged by screening contractors like Dataminr and Fivecast. Lockdown should constrain the *compromised session's* reach, not broadcast "this account just went dark."
   - Sends out-of-band notification to the recovery email/phone.
3. A trusted-device re-auth flow to exit lockdown (Cognito challenge + WebAuthn if available, else TOTP + email).

**Files:** `prisma/schema.prisma` (add `lockdownUntil`, `lockdownRecoveryEmail`), new handler in `apps/api/src/lib/`, session-manager changes, Cognito integration.

### P0.7 No MAIDs, no third-party ad/analytics SDKs (T4 defense)

**Impact:** High for T4. A platform that embeds Firebase Analytics, Crashlytics, AppCenter, Segment, OneSignal, or any ad-network SDK is feeding the same commercial ecosystem that Penlink's Webloc, Fog Data, X-Mode, and similar brokers buy from. ICE doesn't need a warrant or a zero-click exploit to deduce a user's movements if the mobile app itself is broadcasting MAID + location to Google/Firebase/etc., because those data flows reach the RTB-broker market.

**Current:** Unknown at the trellis level — the mobile client wasn't surveyed here. This item is mostly client-side (product repo), but it belongs in the trellis analysis because it's a platform-wide commitment, not a library choice.

**Change:**

1. **SDK inventory.** Audit the mobile client's `pubspec.yaml` (or equivalent) and runtime initialization. For every third-party SDK, determine: does it request IDFA/AAID? does it send per-user events to a third party? does it fingerprint the device? what does its privacy manifest declare?
2. **Forbid by default.** No Firebase Analytics. No Crashlytics as-configured (the Sentry-self-hosted or error-reporting-to-own-backend pattern is acceptable). No attribution SDKs (AppsFlyer, Adjust, Branch). No ad-network SDKs.
3. **Do not collect MAIDs anywhere.** Don't query `IDFA` on iOS or `AAID` on Android. If iOS ATT is surfaced at all (it shouldn't need to be), honour the refusal without dark patterns. Don't touch advertising APIs from Flutter plugins.
4. **If crash reporting is needed,** use Sentry self-hosted or pipe crash dumps to an S3 bucket the app team owns. Strip device identifiers before upload.
5. **If analytics is needed,** use first-party event logging through trellis (already logged, already minimized) rather than a third-party pipeline.
6. **Server-side** (trellis): don't pull MAIDs from Cognito advanced security or from any push-notification wiring. The Notification table (`prisma/schema.prisma` ~L1340) is poll-based, which is good — preserve that.
7. **Document the commitment.** Put the policy in a visible place (`SECURITY.md` in the product repo, plus terms of service). This is how the commitment gets held accountable — an external researcher auditing the app can check.

**Files:** mobile client `pubspec.yaml` (product repo), client bootstrap code, `SECURITY.md` (new, product-repo root), `04-rollout-policy.md` (link). Trellis-side: confirm nothing in `apps/api/src/lib/` pulls MAIDs from Cognito attributes or custom claims.

### P0.8 Minimize subpoenable account linkage (T2 defense)

**Impact:** High for T2. The April 2026 DHS/Reddit subpoena's shopping list — *name, phone, home address, banking/credit card, IP addresses, device model numbers, and names of associated accounts* — maps directly to the fields a typical platform concentrates on the `User` row. Everything trellis collects is a line item in the next such subpoena. The defense is to collect less and to keep what must be collected in systems that are *not* trellis (e.g. payment processor), so that compelling trellis doesn't produce the full picture.

**Current:** Not fully audited — see [`02-current-state.md`](02-current-state.md). `User` model is known to contain `email`, `handle`, `cognitoSub`, `dateOfBirth`, `region`, `dataRegion`, `identityVerified`. Whether it stores phone numbers, home addresses, or billing details is open. Cognito attributes that trellis reads should be inventoried.

**Change:**

1. **Pseudonymity is a supported account mode.** Legal name is never required. `handle` + `displayName` + authenticated Cognito identity is sufficient for all core functionality. A "real name verified" badge is fine as an *optional* signal; not as a gatekeeper for posting, messaging, or circle participation.
2. **Phone verification is optional.** If Cognito is configured to require phone number at signup, remove the requirement. Phone-based MFA should be an option alongside TOTP/WebAuthn, not the only path.
3. **Billing pass-through only.** If a product on trellis ever takes payments (Premium tier, B2B subscriptions), never store card or bank details in trellis. Store only the payment processor's customer ID and status. A subpoena to trellis for "banking and credit card information" then returns *"we do not hold this data; contact Stripe."*
4. **Home address: don't collect.** Deliberate non-collection. Shipping address (if physical goods are ever involved) should live with the fulfillment vendor, not trellis.
5. **Cross-account linkage audit.** Enumerate which identifiers trellis stores (`cognitoSub`, `email`, `emailHash`, `anonymousId`, `handle`, handles from federated identities). Document the linkage graph; reduce where possible. `emailHash` is the kind of column that exists "for deduplication" and stays around forever — decide if it's load-bearing.
6. **Short retention for session/device fingerprints.** Rolls in with P0.3. Device-model/User-Agent history beyond the abuse-response window is direct subpoena ammunition.
7. **Check what Cognito's advanced security features collect.** Cognito Advanced Security fingerprints devices and logs risk signals. If that data is retained at the Cognito layer and subpoenable via AWS, the commitment to minimize trellis-side data is partially undone. Document what Cognito retains; configure it down if possible.

**Forward-looking complement:** BSM Phase 3 ("Adversarial Self-Testing"; see the Border Safety Mode implementation plan in the product repo) plans to red-team the user's profile using the same cross-platform correlation techniques as ShadowDragon (225+ platforms via usernames, emails, writing-style fingerprinting) and the same network-graph analysis as Babel Street / Fivecast. P0.8 minimises what trellis publishes; BSM self-testing surfaces what the user has already exposed elsewhere. Complementary work.

**Files:** `prisma/schema.prisma` (User model), `apps/api/src/lib/auth/`, Cognito user-pool config in `infra/lib/stacks/auth-stack.ts`, signup flows.

---

## P1 — Meaningful new work, still high-value

### P1.1 E2E encryption for DMs

**Impact:** Very high for T2. This is the single biggest hole — DMs are plaintext in RDS and subpoenable.

**Cost:** High. E2E DM is a substantial project: key exchange (X3DH or equivalent), ratchet (Signal-style double-ratchet or MLS), safety-number UX, media encryption, missed-message handling, multi-device key sharing.

**Recommendation:** Scope down. Given the platform size and the scaffolding already present (`encryptedText`, `encryptionAlgorithm`, `encryptionIV`, `UserEncryptionKey` with purpose `message_encryption`), a reasonable MVP:

1. Single-device, per-conversation symmetric key negotiated via ECDH over each party's long-term key.
2. Store `encryptedText` + `encryptionIV`; leave `text` null.
3. Server sees sender, recipient, timestamps, and ciphertext length — that is still substantial metadata exposure.
4. Accept that lost device = lost history (no key escrow) — document this clearly.

Defer full Signal Protocol / MLS until there's a user case for multi-device and perfect forward secrecy.

**Files:** `apps/api/src/lib/` DM handlers, Flutter DM client, `UserEncryptionKey` generation at signup.

### P1.2 Pre-delivery URL scanning (for one-click, not zero-click)

**Impact:** Lower than I'd have said before reading the NPR article. Graphite is zero-click — no URL required — so Safe Browsing on posted URLs does not defend against *this* attack. It still defends against older one-click / smishing / credential-harvest chains and against less-capable adversaries.

**Keep, but reprioritize.** Still worth doing because (a) Predator and earlier Pegasus chains have included one-click paths, (b) Graphite is one of several tools in the ICE toolbox per the article, (c) it's cheap once `LinkCheck` is in place.

**Current:** `DomainReputationService` is reactive (scoring based on user reports and threat-intel signals). There is `/{appName}/{stage}/google-safe-browsing-key` in SSM per CLAUDE.md, suggesting a client was wired up at some point.

**Change:**

- On post creation and DM send, extract URLs, hit Safe Browsing v4, refuse or flag the post if any URL matches.
- Expand to include a tinylist of known Pegasus/Predator/Graphite C2 / lure domains from Citizen Lab IoC feeds (updated via a cron).
- Explicitly *do not* follow the URL server-side for a preview (see P0.5).

**Files:** post-creation handler, DM handler, new `link-check-service.ts` (the `LinkCheck` model already exists).

### P1.3 WebAuthn / passkey MFA

**Impact:** High for T1. TOTP seeds can be exfiltrated from a compromised device. Passkeys are backed by Secure Enclave / Titan M / equivalent; a device-level compromise cannot extract them without breaking the enclave itself.

**Current:** Cognito + TOTP. No WebAuthn.

**Change:** Cognito has WebAuthn support in advanced security features. Wire it up for (1) account creation, (2) exit-from-lockdown, (3) optional second factor in place of TOTP. Make it the default for new accounts.

**Files:** auth flow, Flutter client (platform authenticator APIs), Cognito user-pool config in `auth-stack.ts`.

### P1.4 History-horizon controls

**Impact:** Medium for T1. Reduces what a compromised session can exfiltrate.

**Change:** Per-user setting for "server-side history window" — server hides DMs, posts, and comments older than N days from API responses to *that user's own account*, even though they're still in the DB for receivers and for the user's scheduled export. Combined with lockdown (P0.6), a compromised device can only scrape the recent window.

Related: auto-delete DMs after N days (user-configurable, Signal-style disappearing messages).

**Files:** DM handler, post handler, circle handler, new `historyRetentionDays` field on `User`.

---

## P2 — Smaller wins / hardening

- **P2.1** — Strip User-Agent from audit log, bucket into coarse categories. (Folded into P0.3.)
- **P2.2** — Crypto-erase `UserEncryptionKey` material before row deletion in `delete-account-worker.ts` (explicit overwrite + Prisma delete, then rely on AWS backup rotation). Currently it's a plain cascade delete.
- **P2.3** — Rotate Cognito session cookie salt (`SESSION_SALT`) on a schedule; invalidates all current sessions. Useful as a platform-wide panic button.
- **P2.4** — Add `PostGeoIndex.sensitivityLevel` enforcement: `sensitive` posts never go into the discovery graph, never get federated, never appear in circles wider than tier 0.
- **P2.5** — Cognito-level anomaly detection (CognitoAdvancedSecurity) surfaced to the user as "unusual login from <region>" — lets users trigger P0.6 lockdown without waiting for obvious compromise.
- **P2.6** — Make `metadataVisible` / `locationVisible` actually gate media API responses. Currently dormant.

---

## P3 — Larger architectural bets (flag for later discussion)

- **P3.1** — Sealed-sender DM metadata (Signal-style): server sees recipient but not sender. Requires blind-signature-based auth tokens. High effort, high payoff against T2.
- **P3.2** — Client-side encryption of `User.bio`, `User.displayName`, and other free-text fields with a key derived from a user passphrase (*not* Cognito password). Turns the User table into ciphertext for subpoena purposes. High UX cost (passphrase recovery is painful).
- **P3.3** — Private information retrieval for circles: the current Neo4j queries reveal, to the operator, exactly whom user X cares about and what they view. PIR can hide this but is research-grade and expensive.
