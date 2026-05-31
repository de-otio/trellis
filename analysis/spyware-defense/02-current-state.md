# Current State (from repo survey)

Trellis has a lot of **preparatory** privacy scaffolding — schema fields, dormant flags, and comments marking "future use" — but very little of it is wired up. The most important gaps:

| Area | State | File(s) |
|------|-------|---------|
| DM content | **Plaintext** at rest. `encryptedText`/`encryptionKeyId`/`encryptionAlgorithm`/`encryptionIV` fields exist but are unused. | `prisma/schema.prisma` (DirectMessage, ~L1111–1138) |
| Location | Precise `lat`/`lng`/`geohash`/`place` stored; `User.locationAnonymizationLevel` and `PostGeoIndex.sensitivityLevel` are dormant defaults. | `prisma/schema.prisma` (PostGeoIndex ~L64–83, User ~L168) |
| EXIF / media metadata | `MediaMetadataExtractor` only reads dimensions. `exifData`, `iptcData`, `gpsLatitude`, `gpsLongitude` columns exist and are populated from the client upload. No stripping. | `apps/api/src/lib/media-metadata-extractor.ts`, `prisma/schema.prisma` (MediaFile ~L469–514) |
| Push notifications | Poll-based — no APNs/FCM payload. This is already a strong default. | Comment at `prisma/schema.prisma` ~L1339 |
| Audit logging | IPs and User-Agents are persisted in `SecurityEvent`. `rate-limit.ts:76` contains a TODO for IP scrubbing. | `apps/api/src/lib/audit-logger.ts` (~L53–54) |
| ActivityPub keys | User `privateKey` stored in plaintext in `User`. No rotation mechanism. | `prisma/schema.prisma` (User ~L230–231), `apps/api/src/lib/activitypub/http-signatures.ts` |
| Session & MFA | Cognito JWT + AES-256-GCM session cookie + TOTP MFA + backup codes. No WebAuthn/passkey. | `apps/api/src/lib/auth/cognito-jwt.ts`, `session-manager.ts`, `MfaEnrollment` |
| Panic/lockdown | `User.panicActionConfig` (JSON: `{ enabled, action: 'wipe' \| 'lock' }`) exists but is dormant. | `prisma/schema.prisma` (User ~L245) |
| Account deletion | Cascade deletes on Prisma, S3 media deletion, Cognito AdminDeleteUser. No crypto-erase of keys before row delete. | `apps/api/src/lib/services/user-data-deletion.ts`, `apps/api/src/lambda/delete-account-worker.ts` |
| Link safety | `DomainReputation` + `LinkReport` reactive scoring. No pre-send URL scan, no Safe Browsing lookup on post ingest. | `apps/api/src/lib/domain-reputation-service.ts` |
| Mobile client SDK inventory | **Not surveyed in this pass** (trellis is the backend core only). Any embedded Firebase Analytics, Crashlytics, AppCenter, Segment, OneSignal, or similar SDK is a potential MAID / device-fingerprint leak into the ad-broker ecosystem exploited by Penlink's Webloc. Needs an audit in the product repo that ships the client. | mobile client `pubspec.yaml` / equivalent + call sites (product repo) |
| User-row linkage data | **Not fully surveyed.** The DHS/Reddit subpoena demanded "name, phone, home address, banking/credit card, IP addresses, device model numbers, and names of associated accounts" — that shopping list maps to fields trellis likely has, but the audit wasn't done. Needs: which Cognito attributes does trellis read? Is `User.phoneNumber` populated? Is any billing data stored, or is it pass-through to Stripe/processor? What cross-account linkage exists (Cognito sub + email + handle + anonymousId)? | `prisma/schema.prisma` (User model ~L121–301), Cognito attribute mappings in `apps/api/src/lib/auth/` |

The scaffolding suggests someone has thought about this threat class; **it has not been wired up**. The changes in [`03-priorities.md`](03-priorities.md) are mostly about turning dormant code paths on, not designing new systems from scratch.

Line numbers and field names are point-in-time (repo surveyed 2026-04-12). Re-verify before acting.

## Audit results (2026-04-25)

Follow-up survey filling in rows 17 and 18 of the table above. Other rows were not re-validated.

### P0.7 — Mobile client SDK inventory

This is a client-app audit. Trellis is the backend core and ships no mobile client; the audit below was run against the reference client in the product repo that consumes trellis (file paths are relative to that repo, not this one). It is reproduced here because the MAID/SDK-leak conclusions are platform-level — any client built on trellis must clear the same bar.

Direct dependencies declared in the client's `pubspec.yaml`:

| Package | Version | Category | Where used | MAID / fingerprint risk |
|---------|---------|----------|------------|--------------------------|
| `flutter_riverpod` | ^3.0.0 | SAFE | State management | None |
| `go_router` | ^17.0.0 | SAFE | Navigation | None |
| `dio` | ^5.3.0 | SAFE | HTTP client (only talks to our API) | None |
| `http` | ^1.1.0 | SAFE | HTTP primitive | None |
| `cookie_jar` | ^4.0.0 | SAFE | Cookie persistence for our API | None |
| `dio_cookie_manager` | ^3.0.0 | SAFE | Cookie middleware for dio | None |
| `dartz` | ^0.10.1 | SAFE | Functional types | None |
| `amplify_flutter` | ^2.6.0 | TELEMETRY-LIKELY | Cognito auth core. Pulls `amplify_analytics_pinpoint` 2.6.5 as a **transitive** dep. | **Pinpoint plugin is not registered** — `main.dart` only calls `Amplify.addPlugin(AmplifyAuthCognito())` (client `lib/main.dart:28`) and `amplifyconfiguration.dart` declares only `auth.awsCognitoAuthPlugin`. No analytics plugin is configured, so Pinpoint code is shipped as dead bytes but not initialized. Still: presence on the dep tree is a foot-gun — a future "addPlugin(AmplifyAnalyticsPinpoint())" call would silently start exfiltrating `endpointId` + device metadata. |
| `amplify_auth_cognito` | ^2.6.0 | SAFE-ish | Cognito user pool integration | Phones home to Cognito only (no MAID). |
| `flutter_secure_storage` | ^10.0.0-beta.4 | SAFE | Keychain/Keystore for auth tokens | None |
| `flutter_inappwebview` | ^6.0.0 | SAFE | Embedded web view for auth flows | Inherits webview cookies; no SDK telemetry. |
| `shared_preferences` | ^2.2.0 | SAFE | Local prefs | None |
| `google_maps_flutter` | ^2.5.0 | TELEMETRY-LIKELY | Map rendering. Loads tiles from Google. | Sends user IP + viewport coords to Google on every map view. **Not** a MAID leak per se but is identity/location telemetry to a third party. |
| `geolocator` | ^14.0.0 | SAFE (local) | Reads device GPS via OS APIs only | None — no network egress from the SDK itself, but populates `lat`/`lng` that the API persists. |
| `permission_handler` | ^12.0.0 | SAFE | OS permission prompts | None |
| `connectivity_plus` | ^7.0.0 | SAFE | Network reachability | None |
| `qr_flutter` | ^4.1.0 | SAFE | QR code rendering | None |
| `mobile_scanner` | ^7.0.0 | SAFE | QR camera scanning | None |
| `image_picker` | ^1.0.0 | SAFE | OS image picker | None |
| `cached_network_image` | ^3.3.0 | SAFE | Image cache | Talks only to our origin/CDN. |
| `flutter_image_compress` | ^2.0.0 | SAFE | Local image compression | None |
| `flutter_markdown` | ^0.7.7+1 | SAFE | Markdown rendering | None |
| `flutter_highlight` | ^0.7.0 | SAFE | Code-block syntax highlight | None |
| `intl` | ^0.20.2 | SAFE | i18n | None |
| `equatable` | ^2.0.5 | SAFE | Value equality | None |
| `uuid` | ^4.0.0 | SAFE | Local UUID generation | None |
| `json_annotation` | ^4.9.0 | SAFE | JSON codegen annotations | None |
| `timeago` | ^3.7.0 | SAFE | Relative-time strings | None |
| `logger` | ^2.0.0 | SAFE | Local debug logger only — see the client's `lib/core/errors/global_error_handler.dart`. Comment at L33-34 explicitly notes "you might want to send to crash reporting service" — it isn't wired up. | None — no network sink. |
| `cupertino_icons` | ^1.0.8 | SAFE | Icon set | None |
| `url_launcher` | ^6.3.2 | SAFE | OS URL handler | None |

**Worst-offenders / change list:**

1. **`amplify_analytics_pinpoint` is on the dep tree as a transitive of `amplify_flutter`.** It is dormant (no `addPlugin` call, no `analytics` block in the client's `amplifyconfiguration.dart`) but the foot-gun is real — a single `Amplify.addPlugin(AmplifyAnalyticsPinpoint())` call would activate it. Mitigation: add a CI grep that fails the build if `addPlugin(AmplifyAnalyticsPinpoint` ever appears, or override the dep to exclude it via `dependency_overrides`. Document the no-go in the client repo's `CLAUDE.md`.
2. **`google_maps_flutter`** sends user IP + coordinates to Google on every map render. This is not RTB/MAID telemetry but is third-party location surveillance and worth flagging in the privacy policy. Long-term consider switching map tiles to a privacy-preserving provider (Protomaps/MapLibre) — already an open question elsewhere in the redesign.
3. **There is no `UploadAnalytics` backend.** The client's `lib/core/media/upload/upload_analytics.dart` is just a Dart interface with a `NoOpUploadAnalytics` impl; no Firebase/Mixpanel/Segment SDK exists in the dep tree to back it. Safe today — but the comment "implemented with actual analytics services (Firebase Analytics, Mixpanel, etc.)" should be removed so a future contributor doesn't take it as an invitation.
4. **`AppConfig.sentryDsn`** exists at the client's `lib/core/config/app_config.dart:25` but is never read — no `sentry_flutter` package is in `pubspec.yaml` or `pubspec.lock`. Dead config; should be deleted to avoid signalling intent to add Sentry.

**Ad-tracking permissions in native manifests:**

- Client `ios/Runner/Info.plist`: No `NSUserTrackingUsageDescription`. No `SKAdNetworkItems`. Only `NSCameraUsageDescription` (QR scanning) and `GOOGLE_MAPS_API_KEY`. **Clean.** App Tracking Transparency cannot be requested without a usage-description string, so iOS cannot read IDFA today.
- Client `android/app/src/main/AndroidManifest.xml`: No `com.google.android.gms.permission.AD_ID` declaration. Only `android.permission.CAMERA` plus the Google Maps API key meta-data. **Clean.** Android 13+ requires the `AD_ID` permission to read the GAID; without it the OS returns a zeroed string.
- Grep across `lib/`, `ios/`, `android/` for `AdvertisingId | IDFA | gaid | advertising_id | app_tracking_transparency | AppTrackingTransparency | requestTrackingAuthorization | AD_ID` returns **zero hits.**

**Net assessment:** the reference client is clean of MAID-leak SDKs today. The non-zero risks are (a) the dormant Pinpoint transitive, (b) the third-party tile fetches to Google Maps, and (c) the dead `sentryDsn`/`UploadAnalytics` scaffolding that invites a future contributor to add a tracker. Mitigation for P0.7 is mostly defensive guard-rails, not removals.

### P0.8 — User-row linkage fields

`User` model in [`prisma/schema.prisma`](../../prisma/schema.prisma) (model declared at [L121](../../prisma/schema.prisma#L121)). Every column on `User`:

| Field | Type | Populated by | Subpoena-shopping-list match? |
|-------|------|--------------|-------------------------------|
| `id` | `String` (cuid, pk) | Server-generated on first row write (`post-confirmation` Cognito trigger). | Internal only — not in subpoena shopping list. |
| `email` | `String` (unique, not null) | Cognito `email` attribute, copied in [`post-confirmation.ts:54`](../../apps/api/src/lambda/post-confirmation.ts#L54). | **Yes** — direct identifier, links pseudonym to mailbox. |
| `role` | `UserRole` (enum, default `END_USER`) | Server-set; promoted via admin tooling. | No. |
| `actorUri` | `String?` (unique) | ActivityPub federation — server-set on first publish. | Indirect — public AP identifier. |
| `handle` | `String?` | Cognito `custom:handle` claim copied in `post-confirmation.ts:55`. | **Yes** — "names of any other accounts" maps directly. |
| `createdAt` | `DateTime` | Auto. | No. |
| `cognitoSub` | `String?` (unique) | Cognito user pool sub UUID, set in [`post-confirmation.ts:53`](../../apps/api/src/lambda/post-confirmation.ts#L53). | **Yes** — joins to AWS Cognito records (which DHS/ICE could subpoena from AWS itself, separately, to get email + sign-in IPs + MFA history). |
| `suspended` / `suspendedAt` / `suspendedReason` | `Boolean` / `DateTime?` / `String?` | Admin moderation actions. | No. |
| `partnerId` | `String?` | B2B SSO link. | No. |
| `deletionRequestedAt` / `deletionScheduledAt` / `deletionConfirmedAt` | `DateTime?` x3 | Account-deletion grace period. | No. |
| `username` | `String?` (unique) | Reserved for future pseudonymous sign-up; not populated today. | **Yes** when populated — alternate handle. |
| `stealthMode` | `Boolean` | User pref (dormant). | No. |
| `showOnlineStatus` / `showTypingIndicator` / `showLastSeen` | `Boolean` x3 | User pref. | No. |
| `locationTrackingEnabled` / `locationAnonymizationLevel` | `Boolean` / `Int` | User pref (dormant). | No. |
| `analyticsOptOut` | `Boolean` | User pref (dormant). | No. |
| `emailVerified` / `emailVerifiedAt` | `Boolean` / `DateTime?` | Synced from Cognito `email_verified`. | No. |
| `showVerifiedBadge` | `Boolean` | User pref. | No. |
| `identityVerified` / `identityVerifiedAt` / `identityVerificationMethod` / `identityVerificationProvider` / `showIdentityVerifiedBadge` | mix | Reserved for KYC integration; not populated today. | Indirect — would link to a real-world identity provider (Jumio/Onfido/Veriff) if ever wired. |
| `region` / `dataRegion` | `String` / `String?` | Geo-routing default `EU`. | No. |
| `inboxUrl` / `outboxUrl` / `followersUrl` / `followingUrl` / `friendsUrl` | `String?` x5 | ActivityPub bootstrap — server-derived from `actorUri`. | No. |
| `publicKey` / `privateKey` | `String?` x2 | RSA keypair generated server-side for HTTP signatures. `privateKey` stored **plaintext** (already flagged in row 12 of the table above). | No (cryptographic), but a leaked private key allows impersonation. |
| `encryptionKeyId` | `String?` | Reserved for Border Safety Mode; not populated today. | No. |
| `defaultContext` | `String` (default `"primary"`) | Reserved for decoy-profile feature. | No. |
| `travelModeActive` / `travelModeActivatedAt` | `Boolean` / `DateTime?` | User pref (dormant). | No. |
| `panicActionConfig` | `String?` (JSON) | Dormant — `{ enabled, action: 'wipe'\|'lock' }`. | No. |
| `emailHash` | `String?` (unique) | SHA-256 of `email`; populated by app code (privacy-preserving lookup). | Indirect — same identity as `email`, just hashed. |
| `anonymousId` | `String?` (unique) | Server-generated opaque pseudonym for analytics. | **Cross-account linkage risk** — if both `anonymousId` and `email` are stored on the same row, the row itself is the linkage. |
| `messageRetentionDays` / `autoDeleteAfterDays` | `Int?` x2 | User pref (dormant). | No. |
| `dateOfBirth` / `ageTier` | `DateTime?` / `AgeTier` | Cognito `custom:dateOfBirth` copied in [`post-confirmation.ts:33,57`](../../apps/api/src/lambda/post-confirmation.ts#L33). | **Yes** — DoB is a strong identifier. |
| `quietHoursStart` / `quietHoursEnd` / `quietHoursEnabled` | `Int?` / `Int?` / `Boolean` | User pref. | No. |
| `profileVisibility` / `dmAccess` | `ProfileVisibility` / `DmAccess` enums | User pref. | No. |

**Subpoena-shopping-list mapping:**

| Subpoena field (DHS/Reddit, April 2026) | Stored on `User`? | Stored elsewhere in trellis? | Pass-through? |
|------------------------------------------|-------------------|-------------------------------|---------------|
| Name | No | No (no `firstName`/`lastName` columns anywhere — verified by grep) | No |
| Telephone number | **No** (no `phoneNumber`/`phone_number` column on `User` or any other model) | No | Cognito user-attribute schema does not include `phone_number` reads — verified in [`apps/api/src/lib/auth/cognito-jwt.ts`](../../apps/api/src/lib/auth/cognito-jwt.ts) (`CognitoJwtClaims` interface, L39-47, has only `sub`, `username`, `email`, `custom:userId`, `custom:role`, `custom:handle`, `custom:dataRegion`). |
| Home address | No | No | No |
| Banking / credit-card information | No | No | **Pass-through** would be the architecture if billing existed, but **no Stripe / payment SDK is in trellis at all** — verified by grep across `apps/api/src/`, `prisma/schema.prisma`. There is no `customerId`, `stripeCustomerId`, `paymentMethod` column anywhere. Billing for B2B is not yet implemented. |
| IP addresses | No (not on `User`) | **Yes** on [`SecurityEvent.ipAddress`](../../prisma/schema.prisma#L719) and [`CrossRegionConsent.ipAddress`](../../prisma/schema.prisma#L359). Both indexed. Already flagged in row 11 of the upper table. | No |
| Telephone model number(s) (device IDs) | No | No (no `userAgent` on `User`; UA is on `SecurityEvent.userAgent`/`CrossRegionConsent.userAgent` which captures browser UA, not IMEI/model) | No |
| Names of associated accounts | No, but `email` + `cognitoSub` + `handle` + `actorUri` + `anonymousId` + (future) `username` all live on **the same row**, so the row itself **is** the join key for any pseudonym used on this platform. | — | A subpoena with `email` returns every other identifier in one query. |

**Cognito attributes read by trellis** (from grep of `apps/api/src/lib/auth/` and `apps/api/src/lambda/`):

- **Read** (consumed by lambdas): `email` ([`post-confirmation.ts:33`](../../apps/api/src/lambda/post-confirmation.ts#L33), [`create-auth-challenge.ts:14`](../../apps/api/src/lambda/create-auth-challenge.ts#L14)), `custom:handle`, `custom:dateOfBirth`, `custom:guardianEmail` ([`post-confirmation.ts:33,66`](../../apps/api/src/lambda/post-confirmation.ts#L33)), `custom:invitationCode` ([`pre-signup.ts:9`](../../apps/api/src/lambda/pre-signup.ts#L9)).
- **Read in JWT verifier** ([`cognito-jwt.ts:39-47`](../../apps/api/src/lib/auth/cognito-jwt.ts#L39)): `sub`, `username`, `email`, `custom:userId`, `custom:role`, `custom:handle`, `custom:dataRegion`.
- **Written** (claims override in [`pre-token-generation.ts:81-86`](../../apps/api/src/lambda/pre-token-generation.ts#L81)): `custom:userId`, `custom:role`, `custom:handle`.
- **Not read / not written**: `phone_number`, `address`, `name`, `given_name`, `family_name`, `birthdate` (the standard OIDC personal attributes). Date of birth is collected via the **custom** attribute `custom:dateOfBirth`, not the OIDC-standard `birthdate`.

**Net assessment:** trellis stores far less of the subpoena shopping list than the existing table speculated. The fields actually populated today are `email`, `cognitoSub`, `handle`, optional `dateOfBirth`, plus IP/UA on audit events. Telephone, home address, billing, and device-model identifiers are simply **not collected** — including by Cognito (no `phone_number` claim is read). The biggest residual risks are: (a) `User` row co-locates every pseudonym a person uses on the platform (`email`, `emailHash`, `cognitoSub`, `handle`, `anonymousId`, future `username`) so any single subpoena with one identifier resolves the others; (b) `SecurityEvent.ipAddress` retains login IPs without scrubbing (already a known TODO); (c) DoB is captured as a custom attribute and copied into Postgres, which is a strong identifier and probably not necessary outside of age-tier classification — once `ageTier` is computed, the raw DoB could be discarded.
