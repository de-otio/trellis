/**
 * Environment Configuration
 *
 * Builds the application environment from process.env + AWS service adapters.
 * Shaped to be compatible with the existing handler code that expects CF-style bindings.
 */

import { DynamoKv, createDefaultDynamoClient } from "@de-otio/saas-foundation/kv";
import {
  resolveKvProvider,
  setKvSqlExecutor,
  getKvSqlExecutor,
  makeKvSqlExecutor,
} from "./lib/kv/kv-provider.js";
import { PostgresKv } from "./lib/kv/postgres-kv-namespace.js";
import { S3Storage, createDefaultS3Client } from "@de-otio/saas-foundation/storage";
import { SqsQueue, createDefaultSqsClient } from "@de-otio/saas-foundation/queue";
import {
  resolveSecret,
  secretRef,
  type ResolveContext,
} from "@de-otio/saas-foundation/secrets";
import type {
  KVNamespace,
  CloudflareQueue,
  R2Bucket,
  ExecutionContext,
  AnalyticsEngineDataset,
} from "./types/cloudflare-compat.js";
import type { NotificationType } from "@prisma/client";
import { validateThreatIntelEnv } from "./lib/threat-intel-service.js";
import type { RealtimeTransport } from "./lib/realtime/index.js";
import {
  PollTransport,
  NoopRealtimeTransport,
  InMemorySettingStore,
  CalmDeliveryResolver,
  resolveRealtimeTransport,
} from "./lib/realtime/index.js";
import type { DirectoryProfileConfig } from "./lib/org-category/directory-profile-config.js";
import { resolveDirectoryProfileConfig } from "./lib/org-category/directory-profile-config.js";
import type { DirectorySearchConfig } from "./lib/org-category/directory-search-config.js";
import { resolveDirectorySearchEnv } from "./lib/org-category/directory-search-config.js";
import type { DisclosurePosture } from "./lib/provenance/posture.js";
import {
  DEFAULT_DISCLOSURE_POSTURE,
  parseDisclosurePosture,
} from "./lib/provenance/posture.js";
import { validateEmailEnv } from "./lib/email-provider.js";
import { buildSqsUrl } from "./lib/sqs-url.js";
import type { AgentSurfaceContent } from "./lib/routes/agent-surface.js";

const stage = process.env.STAGE || "dev";

// Delegates to the shared builder (lib/sqs-url.ts) so the request path and the
// worker container use ONE queue-URL convention — incl. SQS_QUEUE_URL_PREFIX,
// which points at the real (name-prefixed) Scaleway MNQ queues.
function sqsUrl(queueName: string): string {
  return buildSqsUrl(queueName, stage);
}

/** Application environment — available to all route handlers */
export interface Env {
  // Database
  DATABASE_URL: string;
  DATABASE_URL_CN?: string;
  DIRECT_URL?: string;
  DATABASE_POOL_MAX?: string;
  DATABASE_POOL_MIN?: string;
  DATABASE_CONNECTION_TIMEOUT_MS?: string;
  // ── DB TLS (DP-7, see lib/db-ssl.ts) ──────────────────────────────────
  /**
   * CA certificate for the Postgres server, PEM text or base64 of the PEM.
   * When set (or `DB_SSL_CA_PATH`), the pools verify the server certificate
   * against it. Unset on a non-local host = legacy unverified TLS + a boot
   * warning. Consumers must provision this; a follow-up makes it required.
   */
  DB_SSL_CA?: string;
  /** Path to a mounted PEM file with the same meaning as `DB_SSL_CA`. */
  DB_SSL_CA_PATH?: string;
  DATABASE_STATEMENT_TIMEOUT_MS?: string;
  DATABASE_IDLE_TIMEOUT_MS?: string;

  // Auth
  SESSION_SECRET: string;
  SESSION_SECRET_FALLBACK?: string;
  SESSION_SALT?: string;

  // MFA verification throttle (AUTH-1 hardening). Thresholds are runtime
  // config, never compiled-in constants (AGENTS.md §7). Defaults live in
  // lib/routes/mfa.ts: 5 attempts per user and 20 per client IP, both over a
  // 300-second window, on /api/mfa/verify and /api/mfa/enroll/finalize.
  /** Max verification attempts per user per window. Default 5. */
  MFA_VERIFY_MAX_ATTEMPTS?: string;
  /** Max verification attempts per client IP per window. Default 20. */
  MFA_VERIFY_MAX_ATTEMPTS_PER_IP?: string;
  /** Window the attempt budgets refill over, in seconds. Default 300. */
  MFA_VERIFY_WINDOW_SECONDS?: string;

  // Purpose-specific at-rest keys (lib/at-rest-secret.ts). Optional: when
  // unset the key is HKDF-derived from SESSION_SECRET with a per-purpose
  // label and SESSION_SECRET_FALLBACK is honoured on read. When set: base64
  // of exactly 32 bytes, asserted at boot; values are sealed via
  // field-encryption under it and the session secret no longer reaches
  // these stores.
  /** KEK for TOTP seeds and backup-code hashes. */
  MFA_ENC_KEY?: string;
  /** KEK for push device tokens. */
  PUSH_TOKEN_ENC_KEY?: string;
  COGNITO_USER_POOL_ID?: string;
  COGNITO_APP_CLIENT_ID?: string;
  COGNITO_REGION?: string;
  COGNITO_HOSTED_UI_DOMAIN?: string;
  COGNITO_REDIRECT_URI?: string;

  // Generic OIDC verification (WS-3.1/3.3). Names per manifest D8 (FROZEN:
  // OIDC_* canonical). All default-derived from COGNITO_* so existing
  // deployments need ZERO config change (see lib/auth/auth-config.ts). D8
  // renames COGNITO_USER_POOL_ID → OIDC_ISSUER_URL and COGNITO_APP_CLIENT_ID →
  // OIDC_APP_CLIENT_ID; the WS-3.1-interim AUTH_* spelling has been removed.
  /** Full issuer URL to pin + JWKS discovery base. Default: the Cognito issuer. */
  OIDC_ISSUER_URL?: string;
  /** App client id / expected `aud`. Default: COGNITO_APP_CLIENT_ID. */
  OIDC_APP_CLIENT_ID?: string;
  /** Explicit JWKS override (air-gapped / fixture tests). Default: unset. */
  OIDC_JWKS_URL?: string;
  /** Identity adapter selection: "cognito" (default) | "keycloak" (WS-3.3). */
  IDENTITY_PROVIDER?: string;
  /** Keycloak service-account client id (proposed D8 addition). */
  IDENTITY_ADMIN_CLIENT_ID?: string;
  /** Keycloak service-account client secret (proposed D8 addition). */
  IDENTITY_ADMIN_CLIENT_SECRET?: string;

  // OAuth device-authorization adapter (T9b-d)
  /** Public Cognito app client used by `trellis-agent-cli` (no secret, PKCE). */
  COGNITO_AGENT_CLIENT_ID?: string;
  /** DynamoDB table holding device-auth records (encrypted tokens + TTL). */
  DEVICE_AUTH_TABLE?: string;
  /** KMS key ARN/id used to wrap the device-auth KEK. */
  DEVICE_AUTH_KMS_KEY_ID?: string;
  /**
   * KMS HMAC key id/ARN (HMAC_SHA_256) used to derive `User.anonymousId` via
   * KMS `GenerateMac`. The key material lives in a FIPS HSM and never leaves
   * KMS. See `lib/pseudonym.ts` + `lib/PSEUDONYM.md`. If unset, anonymousId
   * population is SKIPPED (fail-safe) — never fall back to an unkeyed hash.
   */
  PSEUDONYM_HMAC_KMS_KEY_ID?: string;
  /**
   * HMAC key for GDPR-erasure tombstones (Surveillance-hardening Phase 0, P4 /
   * security review H1): keys the ACCOUNT-report resourceId tombstone so the
   * database alone cannot rainbow-table a deleted user's ID back. Resolved by
   * `resolvePseudonymSecret` in `lib/services/user-data-deletion.ts`, NOT here.
   * This plaintext var is the LOCAL/DEV/CI override only.
   */
  REPORT_PSEUDONYM_SECRET?: string;
  /**
   * Production source for the erasure-tombstone key: the NAME of an SSM
   * Parameter Store SecureString, fetched + KMS-decrypted + cached via AWS
   * Lambda Powertools (`@aws-lambda-powertools/parameters/ssm`). A dedicated,
   * separately-rotatable key — destroying it crypto-shreds prior tombstones.
   * There is deliberately NO `SESSION_SECRET` fallback (DP-10): the tombstone
   * key must be a dedicated, immutable secret — coupling it to the one secret
   * the estate rotates as a kill-switch would re-key every tombstone.
   */
  REPORT_PSEUDONYM_SECRET_PARAM?: string;
  /** DynamoDB table holding refresh-jti dedup + agent-session metadata. */
  AGENT_REFRESH_TABLE?: string;
  /** DynamoDB table backing idempotency-key dedup (T9b-c). Default: {stage}-trellis-idempotency */
  IDEMPOTENCY_TABLE?: string;
  /**
   * DynamoDB table backing the token-bucket rate limiter
   * (`@de-otio/saas-foundation/rate-limit`). When unset, the limiter uses an
   * in-memory store (dev/test). A new table is a deploy prerequisite.
   */
  RATE_LIMIT_TABLE?: string;
  /** Namespace prefix for token-bucket keys within RATE_LIMIT_TABLE. Default: "ratelimit". */
  RATE_LIMIT_NAMESPACE?: string;
  /** Public verification URL the agent shows the user (defaults to example.com). */
  AGENT_VERIFICATION_URI_BASE?: string;

  // Supabase (kept for compatibility with migrated auth handlers)
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_URL_CN?: string;
  SUPABASE_PUBLISHABLE_KEY_CN?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;

  // Microsoft Entra (kept for compatibility)
  ENTRA_TENANT_ID?: string;
  ENTRA_CHINA_TENANT_ID?: string;
  INTERNAL_TENANT_ID?: string;

  // App config
  APP_DOMAIN?: string;
  APP_URL?: string;
  ALLOWED_ORIGINS?: string;
  /**
   * Consumer-supplied content for the agent-surface text routes (GET
   * /llms.txt, GET /security.txt) — plan 034 lane "agent words". Same
   * app-configuration path as APP_DOMAIN/ALLOWED_ORIGINS above: sourced from
   * AGENT_SURFACE_LLMS_TXT / AGENT_SURFACE_SECURITY_TXT env vars, additive and
   * optional. `llmsTxt` absent falls back to core's generic, truthful default
   * (see agent-surface.ts); `securityTxt` absent makes GET /security.txt 404
   * rather than serve a placeholder contact — see agent-surface.ts for why.
   */
  agentSurface?: AgentSurfaceContent;
  ACTIVITYPUB_BASE_URL?: string;
  /**
   * Master switch for ActivityPub federation. Defaults to `false`. When false,
   * the federation-facing routes (actor / inbox / outbox / webfinger / public
   * AP-object endpoints) are NOT registered and outbound delivery is skipped, so
   * a deploy with federation off exposes no AP surface — even via a direct
   * (CloudFront-bypassing) request to an internet-facing ALB. Set by the
   * infrastructure layer from `config.features.activityPub`.
   */
  ACTIVITYPUB_ENABLED: boolean;

  /**
   * Defederation list: comma- or whitespace-separated instance domains whose
   * activities are refused at inbox admission, before any rate-limit budget is
   * spent. A leading `.`/`*.` is optional — matching is on label boundaries,
   * so `example.com` also blocks `mastodon.example.com` but never
   * `notexample.com`. Unset means "federate with everyone".
   */
  ACTIVITYPUB_BLOCKED_DOMAINS?: string;

  /**
   * Per-minute inbox request ceiling per remote INSTANCE DOMAIN (not per
   * actor — actor URIs are free to mint). Defaults to 60. Enforced through the
   * shared distributed token bucket, so it holds across replicas and restarts.
   */
  ACTIVITYPUB_INSTANCE_RATE_LIMIT?: string;

  /**
   * KEK wrapping actor private keys at rest. MUST be 32 bytes of real key
   * material (64 hex chars, or base64/base64url of 32 bytes) — there is
   * deliberately no `SESSION_SECRET` fallback, because session signing and
   * federation identity are different trust domains and must not share a
   * secret. Required whenever `ACTIVITYPUB_ENABLED` is true.
   */
  ACTIVITYPUB_KEY_ENCRYPTION_KEY?: string;

  /**
   * Migration only: the secret existing wrapped keys were written under, so
   * the legacy `SHA-256(secret)` format stays readable until the rewrap
   * backfill completes.
   */
  ACTIVITYPUB_LEGACY_KEY_ENCRYPTION_KEY?: string;

  /**
   * Set to `"false"` AFTER the rewrap backfill to close the legacy read path.
   * Defaults to enabled — closing it early would lock actors out of their keys.
   */
  ACTIVITYPUB_LEGACY_KEY_DECRYPT?: string;

  // ── Client version policy (served by GET /api/app/version-policy) ─────────
  // All four are OPTIONAL and all four are DORMANT by default: unset means the
  // endpoint returns nulls and the 426 backstop is a no-op. Values are
  // operational configuration, never compiled constants — the npm tarball is
  // public, so a hard-coded minimum version would be a published one.
  // Formats are enforced at boot in env-schema.ts (bounded semver; store URLs
  // must be https on an allow-listed store host).
  /** Oldest client version the server still accepts; older ones get 426. */
  CLIENT_MIN_SUPPORTED_VERSION?: string;
  /** Version the client should nudge users toward (never enforced). */
  CLIENT_RECOMMENDED_VERSION?: string;
  /** Android store URL (https, play.google.com). */
  CLIENT_STORE_URL_ANDROID?: string;
  /** iOS store URL (https, apps.apple.com). */
  CLIENT_STORE_URL_IOS?: string;

  /**
   * Trusted-proxy mode for client-IP derivation. See
   * `lib/net/trusted-client-ip.ts`. Values: "none" (default), "alb",
   * "cloudflare". Trellis sets this to "alb" via CDK because the API
   * runs behind an Application Load Balancer.
   */
  TRUSTED_PROXY?: string;

  // CSP overrides
  CSP_CONNECT_SRC?: string;
  CSP_SCRIPT_SRC?: string;
  CSP_STYLE_SRC?: string;

  // Region detection
  IP_GEOLOCATION_API_KEY?: string;
  IP_GEOLOCATION_SERVICE?: "ipapi" | "ip-api" | "cloudflare";
  DEFAULT_REGION?: string;
  ENABLE_IP_GEOLOCATION?: string;
  INTERNAL_EMAIL_DOMAINS?: string;

  // External APIs
  OPENAI_API_KEY?: string;
  GOOGLE_SAFE_BROWSING_API_KEY?: string;
  RECAPTCHA_SITE_KEY?: string;
  RECAPTCHA_SECRET_KEY?: string;

  // Email
  EMAIL_SERVICE?:
    | "aws-ses"
    | "resend"
    | "alibaba-directmail"
    | "tencent-ses"
    // WS-5 Scaleway profile (manifest D8a draft): TEM HTTP API / generic SMTP.
    | "scaleway-tem"
    | "smtp";
  EMAIL_SERVICE_REGION?: string;
  FROM_EMAIL?: string;
  /**
   * Display/product name used in the app-owned email templates (magic-link
   * S-8 subject/body/From display name — see `lib/identity/magic-link-email.ts`).
   * Optional; defaults to "Trellis" everywhere it's read, so an unset var
   * preserves today's behavior exactly. A consumer (e.g. skybber) sets this
   * to its own product name to brand outbound email without forking the
   * shared template.
   */
  EMAIL_BRAND_NAME?: string;
  AWS_SES_REGION?: string;
  /** SES configuration set applied to every send (event publishing/tracking). */
  SES_CONFIGURATION_SET?: string;
  RESEND_API_KEY?: string;
  ALIBABA_ACCESS_KEY_ID?: string;
  ALIBABA_ACCESS_KEY_SECRET?: string;
  ALIBABA_REGION?: string;
  ALIBABA_ACCOUNT_NAME?: string;
  TENCENT_SECRET_ID?: string;
  TENCENT_SECRET_KEY?: string;
  TENCENT_REGION?: string;
  TENCENT_FROM_EMAIL?: string;

  // Admin
  SECURITY_WEBHOOK_URL?: string;

  // Analytics
  ANALYTICS?: AnalyticsEngineDataset;

  // --- P3 signup-metadata config (surveillance-hardening Phase 0, E2) ---
  /**
   * Retention window, in DAYS, for `signup`-type SecurityEvents (the
   * retention-bound client-signal record written at account creation). Longer
   * than InteractionEvent because signup cohorts are the slowest-moving abuse
   * signal — still bounded, never unset. Defaults to
   * `DEFAULT_SIGNUP_EVENT_RETENTION_DAYS` (180) when absent/invalid. Config-
   * driven per the threshold-secrecy invariant — see
   * `lib/signup-metadata.ts` + 07-data-minimization.md.
   */
  SIGNUP_EVENT_RETENTION_DAYS?: string;
  // --- end P3 signup-metadata config ---

  // Cost protection
  OPENAI_BUDGET_ENABLED?: string;
  OPENAI_BUDGET_HOURLY_MAX?: string;
  OPENAI_BUDGET_DAILY_MAX?: string;
  COST_LIMIT_DAILY_TOTAL?: string;
  COST_LIMIT_DAILY_OPENAI?: string;
  COST_LIMIT_DAILY_SES?: string;

  // Deployment
  ENVIRONMENT?: string;
  DEPLOY_ENV?: string;
  APP_VERSION?: string;
  LOG_LEVEL?: string;
  NODE_ENV?: string;
  CI?: string;
  GITHUB_ACTIONS?: string;
  STAGE?: string;
  /**
   * SEC L1 — explicit opt-in for the `/api/admin/test/*` seam (see
   * `lib/routes/admin.ts`). The seam is OFF unless STAGE is `dev`, the process
   * is in CI, or this is exactly `"true"`; `prod`/`production` can never enable
   * it. Surfaced on `Env` (rather than read from `process.env` inside the
   * route) so the gate reads its input from the same place as every other
   * config value, and so it is greppable.
   */
  ENABLE_TEST_ROUTES?: string;

  // AWS
  AWS_REGION?: string;
  AWS_ACCOUNT_ID?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;

  // Cloudflare Images (kept for compatibility with image-normalizer)
  IMAGES?: any;

  // KV Namespaces (DynamoDB-backed, same interface as Cloudflare KV)
  RATE_LIMIT_KV: KVNamespace;
  PRIVACY_PREFERENCES_KV: KVNamespace;
  FEED_CACHE_KV: KVNamespace;
  MODERATION_CACHE_KV: KVNamespace;
  COMMENTS_KV: KVNamespace;
  THREAT_INTEL_CACHE_KV: KVNamespace;
  TAXONOMY_CACHE_KV: KVNamespace;
  FOLLOWERS_KV: KVNamespace;
  EXPORT_JOBS_KV: KVNamespace;
  DELETE_JOBS_KV: KVNamespace;
  CSRF_TOKENS_KV: KVNamespace;
  SESSION_BLOCKLIST_KV: KVNamespace;
  INVITATIONS_KV: KVNamespace;

  // Queues (SQS-backed, same interface as Cloudflare Queue)
  EXPORT_QUEUE: CloudflareQueue;
  DELETE_ACCOUNT_QUEUE: CloudflareQueue;
  FOLLOWERS_EVENTS_QUEUE: CloudflareQueue;
  LINK_CHECK_QUEUE: CloudflareQueue;
  MEDIA_PROCESSING_QUEUE: CloudflareQueue;
  /**
   * WS-2 §4 media control inversion: when true, `completeSession` enqueues
   * the media-processing job explicitly (native `{ objectKey }` message)
   * BEFORE flipping the session to "uploaded". Source:
   * `MEDIA_ENQUEUE_ON_COMPLETE === "true"`. DEFAULT OFF on AWS — zero
   * behavior change until the explicit TWO-DEPLOY cutover (enqueue ON with
   * the S3 notification still live → monitoring gate → notification
   * removal; finding 1 — a single-deploy swap is forbidden). Scaleway (no
   * bucket notifications) runs with this ON from the start.
   */
  MEDIA_ENQUEUE_ON_COMPLETE: boolean;

  // Storage (S3-backed, same interface as Cloudflare R2)
  MEDIA_BUCKET_R2: R2Bucket;
  EXPORT_FILES_R2: R2Bucket;
  /**
   * The RESOLVED media-bucket name that `MEDIA_BUCKET_R2` wraps (after the
   * `${stage}-${appName}-media` fallback). Exposed as a first-class field so the
   * moderation ref bucket (the `ImageRef.bucket` handed to `moderateImage`) is
   * read from the SAME single source the storage binding uses — re-deriving the
   * name (or the fallback) at a call site risks the staging WRITE and the
   * moderation READ pointing at different buckets, which silently fail-closes
   * every image to REVIEW. Source: same `mediaBucket` const as `MEDIA_BUCKET_R2`.
   */
  MEDIA_BUCKET_NAME: string;

  // --- Surveillance-hardening Phase 0 (P2): InteractionEvent capture ---------
  // Operational parameters are RUNTIME CONFIG, not compiled-in constants — the
  // npm tarball is public (threshold-secrecy invariant, see
  // doc/02-technical/surveillance-threat-model/09-public-project-exposure.md).
  // Parsed by resolveInteractionEventConfig() in
  // lib/graph/postgres/interaction-events.ts (which holds the defaults); the
  // graph layer is built without an Env handle, so it reads these from
  // process.env via that parser. Declared here as the documented home.
  /** Master kill-switch for the InteractionEvent dual-write. Default on; set
   *  to "false" to disable (rollback). */
  INTERACTION_EVENTS_ENABLED?: string;
  /** Retention window in days (expiresAt = createdAt + N). Default 120. */
  INTERACTION_EVENT_RETENTION_DAYS?: string;
  /** Fraction 0..1 of high-volume `view` events to record. Default 0 (skip). */
  INTERACTION_EVENT_VIEW_SAMPLE_RATE?: string;
  /** Prune batch size (rows per delete). Default 1000. */
  INTERACTION_EVENT_PRUNE_BATCH_SIZE?: string;
  /** Prune circuit-breaker: max iterations per run. Default 1000. */
  INTERACTION_EVENT_PRUNE_MAX_ITERATIONS?: string;

  // --- Realtime transport seam (single-writer is env.ts) ---------------------
  // Capability seam: core ships a poll default and an interface a consuming app
  // (Skybber) injects a concrete transport into via setRealtimeProvider(). Core
  // never names "appsync" in code. Operational parameters are runtime config per
  // the threshold-secrecy invariant (no compiled-in thresholds).
  /**
   * Feature gates for the realtime seam.
   *   realtimeTransport: which transport core selects as the FALLBACK when no
   *     provider is injected — "poll" (default) | "appsync-events".
   *   realtimePush: whether the createNotification() push hand-off is enabled
   *     (default false). The floor decision is computed either way; this only
   *     gates whether deliver() is invoked.
   */
  features: {
    realtimeTransport: "poll" | "appsync-events";
    realtimePush: boolean;
  };
  /**
   * Manipulative re-engagement NotificationTypes denied to non-adult recipients
   * by the delivery FLOOR (minor-protection). RUNTIME CONFIG per the
   * threshold-secrecy invariant. Default EMPTY (v1 ships no such type).
   */
  REALTIME_REENGAGEMENT_TYPES: ReadonlySet<NotificationType>;
  /** Setting-sync blob namespaces the deployment permits (allowlist). Empty = sync off. */
  REALTIME_SETTING_NAMESPACES: string[];
  /** Max bytes for a single encrypted setting blob (size cap; runtime config). */
  REALTIME_SETTING_MAX_BYTES: number;
  /**
   * Retention window (days) for realtime connection/access logs. Treated like
   * SecurityEvent (retention-bound), never durable ops data. Default short (7).
   */
  REALTIME_CONN_LOG_RETENTION_DAYS: number;
  /**
   * The resolved transport instance. Populated by the env builder with the
   * default (Poll/Noop) via resolveRealtimeTransport(); a consuming app
   * OVERWRITES the slot by calling setRealtimeProvider() before serving.
   * Handlers read env.realtimeTransport — never construct one.
   */
  realtimeTransport: RealtimeTransport;
  // --- end Realtime transport seam ------------------------------------------

  // --- Media config seam (P0a) -----------------------------------------------
  // Every value is env-injected (threshold-secrecy invariant, CLAUDE.md rule 8).
  // Defaults are conservative/fail-closed for local dev; operative values are
  // injected by the consumer (Skybber) via SSM/env vars. The npm tarball is
  // public — no compiled cap/rate-limit/threshold literal ever reaches dist/.
  //
  // Parsed by resolveMediaEnv() below. Handlers read env.media — never construct.
  /**
   * Media upload/serve configuration. All operational thresholds come from
   * env vars; code ships only conservative safe-for-dev defaults.
   */
  media: {
    /**
     * Maximum file size in bytes per media type.
     * Sources: MEDIA_MAX_BYTES_IMAGE / MEDIA_MAX_BYTES_VIDEO / MEDIA_MAX_BYTES_AUDIO.
     */
    maxBytes: { image: number; video: number; audio: number };
    /**
     * Maximum total pixels (width × height) for uploaded images. Guards against
     * decompression-bomb attacks (sharp limitInputPixels). Source: MEDIA_MAX_PIXELS.
     */
    maxPixels: number;
    /**
     * Upload and serve rate limits (requests per minute). Operational values
     * come from env; code ships conservative dev defaults.
     * Sources: MEDIA_RATE_UPLOAD_PER_MIN / MEDIA_RATE_BATCH_PER_MIN / MEDIA_RATE_SERVE_PER_MIN.
     */
    rateLimits: { uploadPerMin: number; batchPerMin: number; servePerMin: number };
    /**
     * Accepted MIME-type allowlists per media type.
     * Sources: MEDIA_ALLOWLIST_IMAGE_JSON / MEDIA_ALLOWLIST_VIDEO_JSON / MEDIA_ALLOWLIST_AUDIO_JSON
     * (JSON arrays). Defaults to narrow safe sets; consumer widens as needed.
     */
    allowlist: { image: string[]; video: string[]; audio: string[] };
    /**
     * Enumerated derivative preset identifiers. Bounds the closed union used by
     * the CAS key builder (T3). Source: MEDIA_PRESETS_JSON (JSON string array).
     */
    presets: string[];
    /**
     * Per-category moderation thresholds: review and quarantine confidence
     * boundaries (0–1). Absence of a key ⇒ fail-closed (treat as review).
     * Source: MEDIA_THRESHOLDS_JSON (JSON object). Real operative numbers live
     * in the consumer's SSM; compiled defaults are intentionally absent so the
     * public tarball contains no threshold values.
     */
    thresholds: Record<string, { review: number; quarantine: number }>;
    /**
     * Canonical output format for the image re-encode pipeline (T7).
     * Must be one of the sharp-writable formats: "jpeg" | "png" | "webp".
     * Source: MEDIA_CANONICAL_FORMAT. Default: "jpeg".
     */
    canonicalFormat: "jpeg" | "png" | "webp";
    /**
     * JPEG/WebP output quality for the re-encode pipeline (1–100).
     * Source: MEDIA_CANONICAL_QUALITY. Default: 85 (conservative dev default).
     */
    canonicalQuality: number;
    /**
     * Maximum video duration in seconds the pipeline will accept. Clips
     * exceeding this cap are rejected before transcoding begins (cost + abuse
     * guard). Source: MEDIA_MAX_DURATION_SECONDS. Default: 60 (conservative
     * dev default; consumer injects operative value via SSM/env).
     */
    maxDurationSeconds: number;
    /**
     * Per-tenant cap on the number of uploads that may reach REVIEW status
     * within the rolling rate window. Tenants that exceed this cap have
     * subsequent uploads auto-rejected until the window resets. Source:
     * MEDIA_REVIEW_RATE_CAP. Default: 20 (conservative dev default; consumer
     * injects operative value via SSM/env).
     */
    reviewRateCap: number;
    /**
     * Per-tenant upload quota DEFAULTS (the free tier): maximum number of
     * stored objects and total bytes. Enforcement is LIVE and fail-closed —
     * both upload gates (routes/media.ts and presigned-upload-handler.ts)
     * hard-deny with 413 (byte-cap) / 429 (object-cap); any quota-read
     * failure denies with 503. (The former "advisory in P0b" note is stale —
     * enforcement shipped with the P0b hardening.)
     *
     * These env values are the platform-wide DEFAULT; a tenant with a non-null
     * `Tenant.storageQuotaBytes` / `Tenant.storageQuotaObjects` override uses
     * that instead (T16 entitlement seam; lib/media/quota-resolution.ts).
     * What USAGE counts against the quota is the shared storage-accounting
     * predicate: only `lifecycle === APPROVED && deletedAt IS NULL` rows
     * (lib/media/storage-accounting.ts). The consumer's CDK feeds the values
     * from SSM. Sources: MEDIA_QUOTA_MAX_OBJECTS / MEDIA_QUOTA_MAX_BYTES.
     */
    uploadQuota: {
      /** Default max stored (APPROVED) objects per tenant. Dev default: 1000. */
      maxObjects: number;
      /** Default max total bytes of stored (APPROVED) media per tenant. Dev default: 1 GiB. */
      maxBytes: number;
    };
    /**
     * Transcription configuration for audio moderation (AUDIO track).
     * outputBucket: S3 bucket for transcription output (no default — absent
     *   means the AUDIO track cannot submit jobs; callers must check).
     * languageCode: BCP-47 language code for the transcription model.
     *   Source: MEDIA_TRANSCRIBE_LANGUAGE_CODE. Default: "en-US".
     */
    transcribe: {
      /** S3 bucket for transcription job output. Source: MEDIA_TRANSCRIBE_OUTPUT_BUCKET. No default. */
      outputBucket?: string;
      /** BCP-47 language code. Source: MEDIA_TRANSCRIBE_LANGUAGE_CODE. Default: "en-US". */
      languageCode: string;
    };
    /**
     * Lifetime (seconds) of a presigned direct-upload grant (T14). Clamped to
     * [60, 3600] by the presign planner regardless of the configured value.
     * Source: MEDIA_PRESIGN_EXPIRY_SECONDS. Default: 900.
     */
    presignExpirySeconds: number;
  };
  // --- end Media config seam -------------------------------------------------

  // --- Directory config seams (org-classification-and-discovery) --------------
  // Both are threshold-secrecy seams (CLAUDE.md rule 8): every operational value
  // is env-injected via its standalone resolver; no compiled default reaches the
  // published tarball beyond conservative dev fallbacks. Handlers/routes read
  // these slots — never construct them.
  //
  // NEIGHBORHOOD fuzz radius (T3). Parsed by resolveDirectoryProfileConfig().
  directoryProfile: DirectoryProfileConfig;
  // Directory-search pagination/rate-limit/timeout bounds (T4). Parsed by
  // resolveDirectorySearchEnv().
  directorySearch: DirectorySearchConfig;
  // --- end Directory config seams --------------------------------------------

  // --- Email-subscription config seam (open-social-web/01-follow-by-email.md §6) ---
  // Threshold-secrecy seam (CLAUDE.md rule 8): every operational value is env-
  // injected via resolveEmailSubscriptionEnv(); no compiled threshold literal
  // ships in the public tarball. Handlers read env.emailSubscription — never
  // construct it.
  emailSubscription: {
    /** Signed confirm-token lifetime (hours). Source: EMAIL_SUB_CONFIRM_TOKEN_TTL_HOURS. Default 48. */
    confirmTokenTtlHours: number;
    /** PENDING-row self-expiry (hours) — primary email-bombing defense. Source: EMAIL_SUB_PENDING_TTL_HOURS. Default 72. */
    pendingTtlHours: number;
    /** UNSUBSCRIBED/BOUNCED suppression-tombstone retention (days). Source: EMAIL_SUB_SUPPRESSION_DAYS. Default 180. */
    suppressionDays: number;
    /** CONFIRMED-row rolling retention (days) so dead subs age out. Source: EMAIL_SUB_CONFIRMED_RETENTION_DAYS. Default 400. */
    confirmedRetentionDays: number;
    /** Subscribe rate limit per source IP per hour. Source: EMAIL_SUB_RATE_PER_IP_PER_HOUR. Default 10. */
    ratePerIpPerHour: number;
    /** Subscribe rate limit per target (feed/actor being followed) per hour. Source: EMAIL_SUB_RATE_PER_TARGET_PER_HOUR. Default 100. */
    ratePerTargetPerHour: number;
    /** Cross-target subscribe rate limit per email address per hour (email-bomb cap). Source: EMAIL_SUB_RATE_PER_EMAIL_PER_HOUR. Default 5. */
    ratePerEmailPerHour: number;
  };
  /**
   * HMAC key for signing/verifying email-subscription confirm/unsubscribe
   * capability tokens and hashing subscriber emails (`emailHash`). REQUIRED
   * (lazily, via `requireEmailSubHmacSecret()`) once email subscriptions are
   * enabled — this must NEVER fall back to SESSION_SECRET or any other
   * ambient secret (key-separation requirement; see the design doc's warning
   * against reusing `activitypub/crypto.ts`). NOT validated at startup — the
   * feature is off by default via a toggle, and existing deployments must
   * keep booting without this var.
   */
  EMAIL_SUB_HMAC_SECRET?: string;
  /**
   * Base64-encoded 32-byte KEK for email-subscription field encryption
   * (`emailEnc`). Decoded and length-checked lazily by
   * `requireEmailSubEncKey()`. NEVER falls back to another secret. NOT
   * validated at startup (see EMAIL_SUB_HMAC_SECRET).
   */
  EMAIL_SUB_ENC_KEY?: string;
  // --- end Email-subscription config seam -------------------------------------

  // --- Collections config seam (open-social-web/03-collections.md §3) ---------
  // Threshold-secrecy seam: the cap is runtime config, never a compiled
  // constant, so no number ships in the public tarball. Resolved by
  // resolveCollectionEnv().
  collection: {
    /** Max items per collection. Source: COLLECTION_MAX_ITEMS. Default 25. */
    maxItems: number;
    /** Max collections per user. Source: COLLECTION_MAX_PER_USER. Default 50. */
    maxPerUser: number;
  };
  // --- end Collections config seam ---------------------------------------------

  // --- Comment rate-limit config seam ------------------------------------------
  // Threshold-secrecy seam (CLAUDE.md rule 8): these were compiled-in constants
  // (`const maxPerMinute = 10`, `const waitTime = 30000`) sitting in a public
  // npm tarball — i.e. published limits, telling anyone who reads them exactly
  // how to pace an abuse campaign to stay under the ceiling. Resolved by
  // resolveCommentRateLimitEnv(); the middleware reads env.commentRateLimit.*
  // and never hardcodes.
  commentRateLimit: {
    /** Max comments per user per minute. Source: COMMENT_RATE_LIMIT_PER_MINUTE. */
    perMinute: number;
    /** Cooldown between a user's comments on ONE post, in seconds. Source: COMMENT_RATE_LIMIT_POST_COOLDOWN_SECONDS. */
    postCooldownSeconds: number;
    /**
     * What to do when the rate-limit store THROWS. "closed" denies (the
     * default: an abuse control that cannot count must not wave traffic
     * through); "open" restores the previous allow-everything behaviour for
     * operators who would rather lose the control than the endpoint.
     * Source: COMMENT_RATE_LIMIT_FAIL_MODE.
     */
    failMode: "closed" | "open";
  };
  // --- end Comment rate-limit config seam --------------------------------------

  // --- Events primitive config seam (events-primitive/README.md §4.8) ---------
  // Threshold-secrecy seam (CLAUDE.md rule 8): every operational cap/threshold
  // is runtime config, never a compiled constant, so no number ships in the
  // public tarball. Handlers read env.event.* — never hardcode. Resolved by
  // resolveEventEnv().
  event: {
    /** Max non-deleted events per tenant. Source: EVENT_MAX_PER_TENANT. */
    maxPerTenant: number;
    /** Max shift slots per event. Source: EVENT_MAX_SHIFTS_PER_EVENT. */
    maxShiftsPerEvent: number;
    /**
     * Max additional guests a single RSVP may bring (party size = 1 + guests).
     * Clamped at the Zod boundary. Source: EVENT_MAX_GUESTS_PER_RSVP.
     */
    maxGuestsPerRsvp: number;
    /** Per-user RSVP writes allowed per hour. Source: EVENT_RSVP_RATE_PER_HOUR. */
    rsvpRatePerHour: number;
    /** Per-event update writes allowed per hour. Source: EVENT_UPDATE_RATE_PER_HOUR. */
    updateRatePerHour: number;
    /**
     * Debounce window that suppresses/consolidates repeated EVENT_UPDATED
     * notifications for one event (amplification guard, SEC-5/SEC-9).
     * Source: EVENT_UPDATE_NOTIFY_COOLDOWN_SECONDS.
     */
    updateNotifyCooldownSeconds: number;
    /** Max page size for GET /api/events. Source: EVENT_LIST_PAGE_MAX. */
    listPageMax: number;
  };
  // --- end Events primitive config seam ---------------------------------------

  // --- Synthetic-content provenance config seam (AI Act Art. 50, D15) --------
  // Resolved by resolveProvenanceEnv(). NOT a threshold-secrecy value — a
  // disclosure posture is published policy, not a detection parameter — but it
  // follows the same env-with-fallback seam so the consumer's deployment can set
  // it per environment without a code change.
  provenance: {
    /**
     * Platform-default disclosure posture for tenants with no override in
     * `Tenant.disclosurePosture`. Source: PROVENANCE_DEFAULT_DISCLOSURE_POSTURE.
     * Default: PROMPTED. An unrecognised value falls back to the default rather
     * than throwing — a typo must not take the API down, and the fallback is the
     * middle posture, so the failure is neither over- nor under-strict.
     */
    defaultDisclosurePosture: DisclosurePosture;
  };
  // --- end provenance config seam ---------------------------------------------
}

/**
 * Track A — the RESERVED key-ring namespace. The client stores its wrapped-DEK
 * bundle under this namespace; the server is blind to it (opaque ciphertext, no
 * parsing). Always allowed, regardless of REALTIME_SETTING_NAMESPACES, so the
 * key-ring works even when no other setting sync is opted in.
 */
export const KEYRING_NAMESPACE = "__keyring";

/**
 * Resolve the realtime config block + the default transport instance from
 * process.env. Single-writer: this is the ONLY place that reads the REALTIME_*
 * env vars. The default is `poll` with an in-memory store + the calm-delivery
 * resolver — fully functional with zero infra. A consuming app overrides the
 * transport via setRealtimeProvider() (resolved here).
 *
 * REALTIME_SETTING_NAMESPACES always includes the reserved `__keyring` namespace
 * (Track A), independent of the deployment's opt-in allowlist.
 */
export function resolveRealtimeEnv(): {
  features: { realtimeTransport: "poll" | "appsync-events"; realtimePush: boolean };
  REALTIME_REENGAGEMENT_TYPES: ReadonlySet<NotificationType>;
  REALTIME_SETTING_NAMESPACES: string[];
  REALTIME_SETTING_MAX_BYTES: number;
  REALTIME_CONN_LOG_RETENTION_DAYS: number;
  realtimeTransport: RealtimeTransport;
} {
  const transportKind =
    process.env.REALTIME_TRANSPORT === "appsync-events"
      ? "appsync-events"
      : "poll";
  const realtimePush = process.env.REALTIME_PUSH_ENABLED === "true";

  // Minor-protection re-engagement denylist (runtime config; default empty).
  const reengagementTypes: ReadonlySet<NotificationType> = new Set(
    (process.env.REALTIME_REENGAGEMENT_TYPES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0) as NotificationType[],
  );

  const configured = (process.env.REALTIME_SETTING_NAMESPACES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Track A — RESERVED system namespace. `__keyring` holds the wrapped-DEK
  // key-ring bundle and is ALWAYS allowed (the store treats it as opaque
  // ciphertext — no parsing), independent of the deployment's opt-in allowlist.
  const namespaces = configured.includes(KEYRING_NAMESPACE)
    ? configured
    : [...configured, KEYRING_NAMESPACE];

  const maxBytesRaw = Number.parseInt(
    process.env.REALTIME_SETTING_MAX_BYTES ?? "",
    10,
  );
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0
    ? maxBytesRaw
    : 65536; // 64 KiB default cap

  const retentionRaw = Number.parseInt(
    process.env.REALTIME_CONN_LOG_RETENTION_DAYS ?? "",
    10,
  );
  const connLogRetentionDays =
    Number.isFinite(retentionRaw) && retentionRaw > 0 ? retentionRaw : 7;

  // Default transport: in-memory store + calm-delivery resolver. Skybber injects
  // a push transport. Core never constructs an AppSync transport —
  // "appsync-events" without an injected provider falls back to noop.
  const settingStore = new InMemorySettingStore();
  const policyResolver = new CalmDeliveryResolver({ reengagementTypes });
  const fallback: RealtimeTransport =
    transportKind === "appsync-events"
      ? new NoopRealtimeTransport(policyResolver)
      : new PollTransport(settingStore, policyResolver);
  const realtimeTransport = resolveRealtimeTransport(fallback);

  return {
    features: { realtimeTransport: transportKind, realtimePush },
    REALTIME_REENGAGEMENT_TYPES: reengagementTypes,
    REALTIME_SETTING_NAMESPACES: namespaces,
    REALTIME_SETTING_MAX_BYTES: maxBytes,
    REALTIME_CONN_LOG_RETENTION_DAYS: connLogRetentionDays,
    realtimeTransport,
  };
}

/**
 * Resolve the media config block from process.env.
 *
 * Single-writer: this is the ONLY place that reads the MEDIA_* env vars.
 * Threshold-secrecy invariant (CLAUDE.md rule 8): no cap / rate-limit /
 * threshold *value* is compiled in. Defaults are conservative dev-safe
 * values only; the consumer injects operative values via SSM/env vars.
 *
 * Absence of a threshold entry ⇒ fail-closed (treated as "review" by the gate).
 */
export function resolveMediaEnv(): { media: {
  maxBytes: { image: number; video: number; audio: number };
  maxPixels: number;
  rateLimits: { uploadPerMin: number; batchPerMin: number; servePerMin: number };
  allowlist: { image: string[]; video: string[]; audio: string[] };
  presets: string[];
  thresholds: Record<string, { review: number; quarantine: number }>;
  canonicalFormat: "jpeg" | "png" | "webp";
  canonicalQuality: number;
  maxDurationSeconds: number;
  reviewRateCap: number;
  uploadQuota: { maxObjects: number; maxBytes: number };
  transcribe: { outputBucket?: string; languageCode: string };
  presignExpirySeconds: number;
} } {
  // --- maxBytes: conservative dev defaults (10 MiB image, 100 MiB video/audio) ---
  // video/audio are PER-TRACK budgets (AR-SEC F2): the presigned byte rail
  // budgets a muxed video as video+audio combined — see presignByteCap()
  // in lib/media/presign-policy.ts.
  const parseBytes = (raw: string | undefined, fallback: number): number => {
    const n = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const maxBytesImage = parseBytes(
    process.env.MEDIA_MAX_BYTES_IMAGE,
    10 * 1024 * 1024,   // 10 MiB (dev default; prod value injected via env)
  );
  const maxBytesVideo = parseBytes(
    process.env.MEDIA_MAX_BYTES_VIDEO,
    100 * 1024 * 1024,  // 100 MiB (dev default; prod value injected via env)
  );
  const maxBytesAudio = parseBytes(
    process.env.MEDIA_MAX_BYTES_AUDIO,
    100 * 1024 * 1024,  // 100 MiB (dev default; prod value injected via env)
  );

  // --- maxPixels: decompression-bomb guard for sharp(limitInputPixels) ---
  const maxPixelsRaw = Number.parseInt(
    process.env.MEDIA_MAX_PIXELS ?? "",
    10,
  );
  // 25 MP dev default — conservative; real limit injected via env
  const maxPixels =
    Number.isFinite(maxPixelsRaw) && maxPixelsRaw > 0
      ? maxPixelsRaw
      : 25_000_000;

  // --- rate limits (requests per minute; conservative dev defaults) ---
  const parseRateLimit = (raw: string | undefined, fallback: number): number => {
    const n = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const uploadPerMin = parseRateLimit(process.env.MEDIA_RATE_UPLOAD_PER_MIN, 10);
  const batchPerMin = parseRateLimit(process.env.MEDIA_RATE_BATCH_PER_MIN, 5);
  const servePerMin = parseRateLimit(process.env.MEDIA_RATE_SERVE_PER_MIN, 60);

  // --- MIME allowlists: narrow safe dev defaults; consumer widens as needed ---
  const parseJsonArray = (raw: string | undefined, fallback: string[]): string[] => {
    if (!raw) return fallback;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed as string[];
      }
    } catch {
      // Malformed JSON → fail-closed: use fallback
    }
    return fallback;
  };

  const allowlistImage = parseJsonArray(
    process.env.MEDIA_ALLOWLIST_IMAGE_JSON,
    ["image/jpeg", "image/png", "image/webp", "image/gif"],
  );
  const allowlistVideo = parseJsonArray(
    process.env.MEDIA_ALLOWLIST_VIDEO_JSON,
    ["video/mp4"],
  );
  const allowlistAudio = parseJsonArray(
    process.env.MEDIA_ALLOWLIST_AUDIO_JSON,
    ["audio/mpeg", "audio/mp4"],
  );

  // --- presets: derivative variant identifiers (empty = no derivatives in P0a) ---
  const presets = parseJsonArray(process.env.MEDIA_PRESETS_JSON, []);

  // --- thresholds: fail-closed; NO default numeric values ---
  // Absence of a key ⇒ the moderation gate treats the category as "review".
  // Real operative numbers live in the consumer's SSM; the public tarball
  // must never contain a compiled threshold literal (threshold-secrecy invariant).
  const thresholds = parseMediaThresholds(process.env.MEDIA_THRESHOLDS_JSON);

  // --- canonicalFormat: the sharp output format for the re-encode pipeline ---
  const rawFormat = process.env.MEDIA_CANONICAL_FORMAT ?? "jpeg";
  const canonicalFormat: "jpeg" | "png" | "webp" =
    rawFormat === "png" || rawFormat === "webp" ? rawFormat : "jpeg";

  // --- canonicalQuality: JPEG/WebP output quality (1-100) ---
  const rawQuality = Number.parseInt(process.env.MEDIA_CANONICAL_QUALITY ?? "", 10);
  const canonicalQuality =
    Number.isFinite(rawQuality) && rawQuality >= 1 && rawQuality <= 100
      ? rawQuality
      : 85; // Conservative dev default

  // --- maxDurationSeconds: video clip cap ---
  const maxDurationSecondsRaw = Number.parseInt(
    process.env.MEDIA_MAX_DURATION_SECONDS ?? "",
    10,
  );
  // 60 s conservative dev default; consumer injects operative value via env.
  const maxDurationSeconds =
    Number.isFinite(maxDurationSecondsRaw) && maxDurationSecondsRaw > 0
      ? maxDurationSecondsRaw
      : 60;

  // --- reviewRateCap: per-tenant REVIEW-generating upload cap ---
  const reviewRateCapRaw = Number.parseInt(
    process.env.MEDIA_REVIEW_RATE_CAP ?? "",
    10,
  );
  // 20 conservative dev default; consumer injects operative value via env.
  const reviewRateCap =
    Number.isFinite(reviewRateCapRaw) && reviewRateCapRaw > 0
      ? reviewRateCapRaw
      : 20;

  // --- uploadQuota: per-tenant object count + byte ceiling ---
  const quotaMaxObjectsRaw = Number.parseInt(
    process.env.MEDIA_QUOTA_MAX_OBJECTS ?? "",
    10,
  );
  const quotaMaxObjects =
    Number.isFinite(quotaMaxObjectsRaw) && quotaMaxObjectsRaw > 0
      ? quotaMaxObjectsRaw
      : 1000; // 1 000 objects dev default

  const quotaMaxBytesRaw = Number.parseInt(
    process.env.MEDIA_QUOTA_MAX_BYTES ?? "",
    10,
  );
  const quotaMaxBytes =
    Number.isFinite(quotaMaxBytesRaw) && quotaMaxBytesRaw > 0
      ? quotaMaxBytesRaw
      : 1024 * 1024 * 1024; // 1 GiB dev default

  // --- transcribe config ---
  // outputBucket has no default (absent ⇒ AUDIO track cannot submit jobs).
  const transcribeOutputBucket = process.env.MEDIA_TRANSCRIBE_OUTPUT_BUCKET || undefined;

  const rawLanguageCode = (process.env.MEDIA_TRANSCRIBE_LANGUAGE_CODE ?? "").trim();
  const transcribeLanguageCode = rawLanguageCode.length > 0 ? rawLanguageCode : "en-US";

  // --- presignExpirySeconds: lifetime of a presigned direct-upload grant ---
  // (T14). Conservative dev default (15 min); the planner clamps to
  // [60, 3600] regardless of what arrives here (presign-policy.ts).
  const presignExpiryRaw = Number.parseInt(
    process.env.MEDIA_PRESIGN_EXPIRY_SECONDS ?? "",
    10,
  );
  const presignExpirySeconds =
    Number.isFinite(presignExpiryRaw) && presignExpiryRaw > 0
      ? presignExpiryRaw
      : 900;

  return {
    media: {
      maxBytes: { image: maxBytesImage, video: maxBytesVideo, audio: maxBytesAudio },
      maxPixels,
      rateLimits: { uploadPerMin, batchPerMin, servePerMin },
      allowlist: { image: allowlistImage, video: allowlistVideo, audio: allowlistAudio },
      presets,
      thresholds,
      canonicalFormat,
      canonicalQuality,
      maxDurationSeconds,
      reviewRateCap,
      uploadQuota: { maxObjects: quotaMaxObjects, maxBytes: quotaMaxBytes },
      transcribe: { outputBucket: transcribeOutputBucket, languageCode: transcribeLanguageCode },
      presignExpirySeconds,
    },
  };
}

/**
 * Parse MEDIA_THRESHOLDS_JSON into a validated threshold map.
 *
 * Only entries whose `review` and `quarantine` values are numbers in [0, 1] are
 * accepted. Out-of-range entries are silently dropped — an invalid threshold is
 * treated as absent, which ⇒ fail-closed (review). This guards against a
 * misconfigured value accidentally opening the gate.
 *
 * Exported for unit testing.
 */
export function parseMediaThresholds(
  raw: string | undefined,
): Record<string, { review: number; quarantine: number }> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, { review: number; quarantine: number }> = {};
  for (const [category, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as any).review === "number" &&
      typeof (value as any).quarantine === "number" &&
      (value as any).review >= 0 &&
      (value as any).review <= 1 &&
      (value as any).quarantine >= 0 &&
      (value as any).quarantine <= 1
    ) {
      result[category] = {
        review: (value as any).review as number,
        quarantine: (value as any).quarantine as number,
      };
    }
    // Out-of-range or malformed entries are dropped (fail-closed)
  }
  return result;
}

/**
 * Parse a positive integer env var, falling back to `fallback` when absent,
 * non-numeric, or <= 0. Local defaulting helper — mirrors the inline
 * `parseBytes`/`parseRateLimit` closures in resolveMediaEnv() above.
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the email-subscription config block from `source` (defaults to
 * `process.env`; tests can inject a fixture object).
 *
 * Single-writer: this is the ONLY place that reads the NUMERIC EMAIL_SUB_*
 * env vars. The two REQUIRED secrets — EMAIL_SUB_HMAC_SECRET and
 * EMAIL_SUB_ENC_KEY — are deliberately NOT read here: they're set directly
 * onto Env in buildEnv() and resolved lazily via requireEmailSubHmacSecret()
 * / requireEmailSubEncKey(), so their absence never fails this resolver or
 * validateEnv()'s startup path (the feature is off by default via a toggle).
 * Design: open-social-web/01-follow-by-email.md §6.
 */
export function resolveEmailSubscriptionEnv(
  source: NodeJS.ProcessEnv = process.env,
): {
  emailSubscription: {
    confirmTokenTtlHours: number;
    pendingTtlHours: number;
    suppressionDays: number;
    confirmedRetentionDays: number;
    ratePerIpPerHour: number;
    ratePerTargetPerHour: number;
    ratePerEmailPerHour: number;
  };
} {
  return {
    emailSubscription: {
      confirmTokenTtlHours: parsePositiveInt(
        source.EMAIL_SUB_CONFIRM_TOKEN_TTL_HOURS,
        48,
      ),
      pendingTtlHours: parsePositiveInt(source.EMAIL_SUB_PENDING_TTL_HOURS, 72),
      suppressionDays: parsePositiveInt(source.EMAIL_SUB_SUPPRESSION_DAYS, 180),
      confirmedRetentionDays: parsePositiveInt(
        source.EMAIL_SUB_CONFIRMED_RETENTION_DAYS,
        400,
      ),
      ratePerIpPerHour: parsePositiveInt(
        source.EMAIL_SUB_RATE_PER_IP_PER_HOUR,
        10,
      ),
      ratePerTargetPerHour: parsePositiveInt(
        source.EMAIL_SUB_RATE_PER_TARGET_PER_HOUR,
        100,
      ),
      ratePerEmailPerHour: parsePositiveInt(
        source.EMAIL_SUB_RATE_PER_EMAIL_PER_HOUR,
        5,
      ),
    },
  };
}

/**
 * Resolve the collections config block from `source` (defaults to
 * `process.env`; tests can inject a fixture object).
 *
 * Threshold-secrecy seam (CLAUDE.md rule 8): the cap is runtime config, never
 * a compiled constant, so no number ships in the public tarball. Design:
 * open-social-web/03-collections.md §3.
 */
export function resolveCollectionEnv(
  source: NodeJS.ProcessEnv = process.env,
): { collection: { maxItems: number; maxPerUser: number } } {
  return {
    collection: {
      maxItems: parsePositiveInt(source.COLLECTION_MAX_ITEMS, 25),
      maxPerUser: parsePositiveInt(source.COLLECTION_MAX_PER_USER, 50),
    },
  };
}

/**
 * Resolve the comment rate-limit config block (threshold-secrecy, rule 8).
 *
 * Single-writer: the ONLY place that reads COMMENT_RATE_LIMIT_* env vars. The
 * defaults reproduce the previous compiled-in behaviour exactly (10/min, 30s
 * per-post cooldown) so this is a config seam, not a policy change — except
 * `failMode`, which deliberately flips: see the middleware for why.
 */
export function resolveCommentRateLimitEnv(
  source: NodeJS.ProcessEnv = process.env,
): {
  commentRateLimit: {
    perMinute: number;
    postCooldownSeconds: number;
    failMode: "closed" | "open";
  };
} {
  return {
    commentRateLimit: {
      perMinute: parsePositiveInt(source.COMMENT_RATE_LIMIT_PER_MINUTE, 10),
      postCooldownSeconds: parsePositiveInt(
        source.COMMENT_RATE_LIMIT_POST_COOLDOWN_SECONDS,
        30,
      ),
      // Anything other than an explicit "open" is closed. An unset, misspelt
      // or empty value must not silently disable the control — that is the
      // failure mode this whole change exists to remove.
      failMode: source.COMMENT_RATE_LIMIT_FAIL_MODE === "open" ? "open" : "closed",
    },
  };
}

/**
 * Resolve the synthetic-content provenance config block (AI Act Art. 50, D15).
 *
 * Single-writer: the ONLY place that reads PROVENANCE_* env vars. An
 * unrecognised posture string resolves to {@link DEFAULT_DISCLOSURE_POSTURE}
 * rather than throwing — see the field doc on `Env.provenance`.
 */
export function resolveProvenanceEnv(
  source: NodeJS.ProcessEnv = process.env,
): { provenance: { defaultDisclosurePosture: DisclosurePosture } } {
  return {
    provenance: {
      defaultDisclosurePosture:
        parseDisclosurePosture(source.PROVENANCE_DEFAULT_DISCLOSURE_POSTURE) ??
        DEFAULT_DISCLOSURE_POSTURE,
    },
  };
}

/**
 * Resolve the events-primitive config block from `source` (defaults to
 * `process.env`; tests can inject a fixture object).
 *
 * Single-writer: this is the ONLY place that reads the EVENT_* env vars.
 * Threshold-secrecy seam (CLAUDE.md rule 8): every value is runtime config with
 * a CONSERVATIVE dev-safe fallback, never a compiled constant sprinkled at call
 * sites. Design: plans/events-primitive/README.md §4.8.
 */
export function resolveEventEnv(source: NodeJS.ProcessEnv = process.env): {
  event: {
    maxPerTenant: number;
    maxShiftsPerEvent: number;
    maxGuestsPerRsvp: number;
    rsvpRatePerHour: number;
    updateRatePerHour: number;
    updateNotifyCooldownSeconds: number;
    listPageMax: number;
  };
} {
  return {
    event: {
      maxPerTenant: parsePositiveInt(source.EVENT_MAX_PER_TENANT, 500),
      maxShiftsPerEvent: parsePositiveInt(source.EVENT_MAX_SHIFTS_PER_EVENT, 50),
      maxGuestsPerRsvp: parsePositiveInt(source.EVENT_MAX_GUESTS_PER_RSVP, 10),
      rsvpRatePerHour: parsePositiveInt(source.EVENT_RSVP_RATE_PER_HOUR, 60),
      updateRatePerHour: parsePositiveInt(source.EVENT_UPDATE_RATE_PER_HOUR, 20),
      updateNotifyCooldownSeconds: parsePositiveInt(
        source.EVENT_UPDATE_NOTIFY_COOLDOWN_SECONDS,
        3600,
      ),
      listPageMax: parsePositiveInt(source.EVENT_LIST_PAGE_MAX, 50),
    },
  };
}

/**
 * Assemble a Postgres URL from Secrets Manager at runtime.
 *
 * The secret is fetched with the AWS SDK. Credentials live on the returned
 * string only — process.env is never mutated, so child processes, core dumps,
 * and `ecs execute-command` → `env` do not leak the password.
 *
 * Cached at module scope after first resolution.
 */
let cachedDatabaseUrl: string | undefined;

async function resolveDatabaseUrl(): Promise<string> {
  if (cachedDatabaseUrl) return cachedDatabaseUrl;

  // Local dev / migrations: DATABASE_URL in env wins (already the typical pattern
  // for prisma migrate scripts). Not a security regression because local dev isn't
  // prod, and migration jobs are short-lived processes.
  if (process.env.DATABASE_URL) {
    cachedDatabaseUrl = process.env.DATABASE_URL;
    return cachedDatabaseUrl;
  }

  // AWS path: task role has secretsmanager:GetSecretValue on the ARN.
  const secretArn = process.env.DB_SECRET_ARN;
  if (secretArn) {
    const region = process.env.AWS_REGION ?? "eu-central-1";
    const { SecretsManagerClient, GetSecretValueCommand } = await import(
      "@aws-sdk/client-secrets-manager"
    );
    const client = new SecretsManagerClient({ region });
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (!response.SecretString) {
      throw new Error(`Secret ${secretArn} has no SecretString value`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(response.SecretString);
    } catch {
      throw new Error(`Secret ${secretArn} is not valid JSON`);
    }

    const user = parsed.username;
    const pass = parsed.password;
    const host = parsed.host;
    const port = String(parsed.port ?? 5432);
    const dbname = (parsed.dbname as string | undefined) ?? process.env.DB_NAME ?? "trellis";

    if (typeof user !== "string" || typeof pass !== "string" || typeof host !== "string") {
      throw new Error(`Secret ${secretArn} missing required fields username/password/host`);
    }
    if (!/^[\w.-]+$/.test(host)) {
      throw new Error(`Invalid secret host: must match /^[\\w.-]+$/, got "${host}"`);
    }
    if (!/^\d+$/.test(port)) {
      throw new Error(`Invalid secret port: must be numeric, got "${port}"`);
    }
    if (!/^[\w-]+$/.test(dbname)) {
      throw new Error(`Invalid DB_NAME: must match /^[\\w-]+$/, got "${dbname}"`);
    }

    cachedDatabaseUrl = `postgresql://${user}:${encodeURIComponent(pass)}@${host}:${port}/${dbname}`;
    return cachedDatabaseUrl;
  }

  // Legacy env-var path (pre-runtime-fetch). Kept for tests and any caller that
  // still injects these directly. Prefer DATABASE_URL or DB_SECRET_ARN.
  const user = process.env.DB_SECRET_USERNAME;
  const pass = process.env.DB_SECRET_PASSWORD;
  const host = process.env.DB_SECRET_HOST;
  const port = process.env.DB_SECRET_PORT || "5432";
  const dbname = process.env.DB_NAME || "trellis";
  if (!user || !pass || !host) {
    throw new Error(
      "Database config missing: set DATABASE_URL (local), DB_SECRET_ARN (AWS), or DB_SECRET_USERNAME/PASSWORD/HOST",
    );
  }
  if (!/^[\w.-]+$/.test(host)) {
    throw new Error(`Invalid DB_SECRET_HOST: must match /^[\\w.-]+$/, got "${host}"`);
  }
  if (!/^\d+$/.test(port)) {
    throw new Error(`Invalid DB_SECRET_PORT: must be numeric, got "${port}"`);
  }
  if (!/^[\w-]+$/.test(dbname)) {
    throw new Error(`Invalid DB_NAME: must match /^[\\w-]+$/, got "${dbname}"`);
  }
  cachedDatabaseUrl = `postgresql://${user}:${encodeURIComponent(pass)}@${host}:${port}/${dbname}`;
  return cachedDatabaseUrl;
}

/** S1.4 — Validate critical environment variables at startup */
export function validateEnv(env: Env): string[] {
  const errors: string[] = [];

  if (!env.SESSION_SECRET) {
    errors.push("SESSION_SECRET is required");
  } else if (env.SESSION_SECRET.length < 32) {
    errors.push("SESSION_SECRET must be at least 32 characters");
  }

  // Auth issuer + audience must be resolvable. This mirrors resolveAuthConfig()
  // (lib/auth/auth-config.ts) rather than hard-requiring Cognito: the neutral
  // OIDC_* vars (WS-3.3 Keycloak / any generic OIDC issuer) satisfy it, and the
  // legacy COGNITO_* derivation still satisfies it byte-identically. Requiring
  // COGNITO_* unconditionally here would fail-closed every non-Cognito (e.g.
  // Scaleway/Keycloak) deployment even though the verifier itself is happy.
  if (!env.OIDC_ISSUER_URL && !env.COGNITO_USER_POOL_ID) {
    errors.push(
      "auth issuer is required — set OIDC_ISSUER_URL (generic OIDC / Keycloak) or COGNITO_USER_POOL_ID (Cognito)",
    );
  }
  if (!env.OIDC_APP_CLIENT_ID && !env.COGNITO_APP_CLIENT_ID) {
    errors.push(
      "auth audience is required — set OIDC_APP_CLIENT_ID (generic OIDC / Keycloak) or COGNITO_APP_CLIENT_ID (Cognito)",
    );
  }
  // A non-Cognito issuer must also name its JWKS URI: the fallback the verifier
  // derives is Cognito's `/.well-known/jwks.json`, which 404s on Keycloak and
  // friends, and the resulting missing key is reported as `invalid_signature`
  // — every token rejected, with the error pointing at crypto instead of at
  // config (observed live on dev, 2026-08-02). Mirrors resolveAuthConfig()
  // [SEC-6b]; kept here too so `validateEnv` alone catches a bad deploy.
  if (
    env.OIDC_ISSUER_URL &&
    !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[^/]+$/.test(env.OIDC_ISSUER_URL) &&
    !env.OIDC_JWKS_URL
  ) {
    errors.push(
      "OIDC_JWKS_URL is required for a non-Cognito issuer — take jwks_uri from " +
        `${env.OIDC_ISSUER_URL}/.well-known/openid-configuration`,
    );
  }

  // SECURITY (T17): the invitation gate fails closed without this binding —
  // refuse to start rather than serve with invitation validation/redemption
  // silently rejecting everything. buildEnv() always constructs it (DynamoKv
  // over DYNAMODB_TABLE), so this only fires for a hand-built/miswired Env.
  if (!env.INVITATIONS_KV) {
    errors.push(
      "INVITATIONS_KV binding is missing — the invitation gate would fail closed (all invitation validation/redemption rejected). Check DYNAMODB_TABLE / buildEnv wiring.",
    );
  }

  // SECURITY (WS-2 §4 finding 1, test-critique F1): the media control-
  // inversion flag ON with no queue binding would otherwise let
  // `completeSession` flip sessions to "uploaded" WITHOUT enqueuing a
  // moderation job — permanently unmoderated media once Deploy 2 removes the
  // S3 notification. Flag on ⇒ queue REQUIRED; refuse to start otherwise.
  // (`completeSession` also carries a runtime fail-closed guard for
  // hand-built Envs that bypass this startup check.)
  if (env.MEDIA_ENQUEUE_ON_COMPLETE && !env.MEDIA_PROCESSING_QUEUE) {
    errors.push(
      "MEDIA_ENQUEUE_ON_COMPLETE is true but MEDIA_PROCESSING_QUEUE is missing — completions could flip sessions without enqueuing moderation (unmoderated media). Wire the queue or turn the flag off.",
    );
  }

  // Email provider config — validate ONLY when a provider is explicitly
  // selected via the RAW env var. buildEnv() defaults EMAIL_SERVICE to
  // "aws-ses", so reading env.EMAIL_SERVICE here would fire for every
  // deployment; reading process.env.EMAIL_SERVICE keeps deployments that never
  // opt in unaffected.
  if (process.env.EMAIL_SERVICE) {
    errors.push(...validateEmailEnv(process.env));
  }

  // SECURITY (Phase 7 F7): enabling federation without a real 32-byte actor-key
  // KEK is not a degraded mode — actor private keys would be unwrappable (or,
  // before this change, wrapped under the reused session secret). Only checked
  // when ACTIVITYPUB_ENABLED, so non-federating deployments are unaffected.
  // At-rest keys for MFA seeds / push tokens (DP-3): optional, but when set
  // they must be real 32-byte keys. A mis-encoded key would otherwise fail
  // the first MFA verification or push registration instead of the rollout.
  for (const name of ["MFA_ENC_KEY", "PUSH_TOKEN_ENC_KEY"] as const) {
    const raw = env[name];
    if (raw !== undefined && raw !== "") {
      const decoded = Buffer.from(raw.trim(), "base64");
      if (decoded.length !== 32) {
        errors.push(
          `${name} must be base64 of exactly 32 bytes (got ${decoded.length}) — a passphrase is not a key. Unset it to fall back to the session-derived key.`,
        );
      }
    }
  }

  if (env.ACTIVITYPUB_ENABLED) {
    const kek = env.ACTIVITYPUB_KEY_ENCRYPTION_KEY;
    if (!kek) {
      errors.push(
        "ACTIVITYPUB_KEY_ENCRYPTION_KEY is required when ACTIVITYPUB_ENABLED is true — 32 bytes (64 hex chars or base64). There is no SESSION_SECRET fallback.",
      );
    } else if (
      !/^[0-9a-fA-F]{64}$/.test(kek.trim()) &&
      !/^[A-Za-z0-9+/]{43}=?$/.test(kek.trim()) &&
      !/^[A-Za-z0-9\-_]{43}$/.test(kek.trim())
    ) {
      errors.push(
        "ACTIVITYPUB_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars, or base64/base64url of 32 bytes) — a passphrase is not a key.",
      );
    }
  }

  // SECURITY (deep pass DP-13): the federation inbox's per-instance rate limit
  // is only "shared" when a distributed limiter backs it. Without
  // KV_PROVIDER=postgres (or a RATE_LIMIT_TABLE) the limiter silently becomes
  // per-process memory — the exact F6 defect — so refuse to enable federation
  // on top of it rather than let a rolling deploy reset every bucket.
  if (env.ACTIVITYPUB_ENABLED) {
    const kvProvider = process.env.KV_PROVIDER;
    if (kvProvider !== "postgres" && !env.RATE_LIMIT_TABLE) {
      errors.push(
        "ACTIVITYPUB_ENABLED is true but the rate limiter would be per-process memory — set KV_PROVIDER=postgres (or RATE_LIMIT_TABLE) so federation limits are shared across replicas.",
      );
    }
  }

  // SECURITY (Phase 6 M3): in production a missing Safe Browsing key means
  // every uncached link check fails to UNKNOWN and the interstitial fires on
  // everything — a link-safety feature that silently does nothing. Refuse the
  // deploy instead. Non-prod stages are unaffected.
  errors.push(
    ...validateThreatIntelEnv({
      GOOGLE_SAFE_BROWSING_API_KEY: env.GOOGLE_SAFE_BROWSING_API_KEY,
      STAGE: env.STAGE,
      NODE_ENV: env.NODE_ENV,
    }),
  );

  return errors;
}

/**
 * Require EMAIL_SUB_HMAC_SECRET — the key used to sign/verify email-
 * subscription confirm/unsubscribe capability tokens and to hash subscriber
 * emails (`emailHash`). Lazily required: NOT checked by `validateEnv()` (the
 * feature is off by default via a toggle, so existing deployments must keep
 * booting without this var) — throws only when a handler actually needs it.
 *
 * Must NEVER fall back to SESSION_SECRET or any other ambient secret
 * (key-separation requirement — see open-social-web/01-follow-by-email.md
 * §6's warning against reusing `activitypub/crypto.ts`, which collapses this
 * separation).
 */
export function requireEmailSubHmacSecret(env: Env): string {
  const secret = env.EMAIL_SUB_HMAC_SECRET;
  if (!secret) {
    throw new Error(
      "EMAIL_SUB_HMAC_SECRET is required for email-subscription token signing " +
        "and email hashing but is not set. It must NEVER fall back to " +
        "SESSION_SECRET or any other ambient secret — set EMAIL_SUB_HMAC_SECRET explicitly.",
    );
  }
  return secret;
}

/**
 * Require EMAIL_SUB_ENC_KEY — the base64-encoded 32-byte KEK for
 * email-subscription field encryption (`emailEnc`) — and decode it. Mirrors
 * `resolveKek()` in `lib/oauth/envelope-crypto.ts` (DEVICE_AUTH_KEK_BASE64):
 * absence or a wrong-length decode both throw.
 *
 * Lazily required, same as `requireEmailSubHmacSecret()` — not checked at
 * startup, never falls back to another secret.
 */
export function requireEmailSubEncKey(env: Env): Buffer {
  const raw = env.EMAIL_SUB_ENC_KEY;
  if (!raw) {
    throw new Error(
      "EMAIL_SUB_ENC_KEY is required for email-subscription field encryption " +
        "but is not set. Set EMAIL_SUB_ENC_KEY to a base64-encoded 32-byte key.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `EMAIL_SUB_ENC_KEY must decode to exactly 32 bytes, got ${key.length}`,
    );
  }
  return key;
}

/**
 * Resolve a raw-string secret: a local env var wins (dev / migrations), else
 * fetch from AWS Secrets Manager via the foundation resolver.
 *
 * The plaintext stays on the returned value only — process.env is never
 * mutated, so the secret can't leak through env-var exposure (Lambda console,
 * `ecs execute-command` → `env`, core dumps). Resolution goes through
 * `@de-otio/saas-foundation/secrets`, which adds KMS-at-rest, per-ARN IAM,
 * CloudTrail read audit, transient retry, and a module-scoped cache.
 *
 * @param envValue the local-dev override (e.g. process.env.SESSION_SECRET)
 * @param arn      the Secrets Manager ARN (e.g. process.env.SESSION_SECRET_ARN)
 */
async function resolveRawSecret(
  envValue: string | undefined,
  arn: string | undefined,
  context?: ResolveContext,
): Promise<string | undefined> {
  if (envValue) return envValue;
  if (!arn) return undefined;
  const bytes = await resolveSecret(secretRef(arn), context);
  return bytes.toString("utf-8");
}

/**
 * Build the application environment — fetches secrets from AWS if needed.
 *
 * @param context optional foundation `ResolveContext` for secret resolution.
 *   Production passes nothing (default AWS clients + cache). Tests inject a
 *   `MemorySecretStore`'s clients to exercise the Secrets Manager path
 *   deterministically without hitting AWS.
 */
export async function buildEnv(context?: ResolveContext): Promise<Env> {
  const appName = process.env.APP_NAME || "trellis";
  const mediaBucket = process.env.MEDIA_BUCKET_NAME || `${stage}-${appName}-media`;
  const exportsBucket = process.env.EXPORTS_BUCKET_NAME || `${stage}-${appName}-exports`;
  const s3Client = createDefaultS3Client();
  const sqsClient = createDefaultSqsClient();
  const dynamoClient = createDefaultDynamoClient();
  const kvTableName = process.env.DYNAMODB_TABLE || `${stage}-trellis`;

  // Resolve auth secrets: local env wins; else AWS Secrets Manager via the
  // foundation resolver. Plaintext stays on the returned Env only — process.env
  // is never mutated. Fail closed below if the required session secret is absent.
  const sessionSecret = await resolveRawSecret(
    process.env.SESSION_SECRET,
    process.env.SESSION_SECRET_ARN,
    context,
  );
  const sessionSecretFallback = await resolveRawSecret(
    process.env.SESSION_SECRET_FALLBACK,
    process.env.SESSION_SECRET_FALLBACK_ARN,
    context,
  );
  const openaiApiKey = await resolveRawSecret(
    process.env.OPENAI_API_KEY,
    process.env.OPENAI_API_KEY_ARN,
    context,
  );

  if (!sessionSecret) {
    // Fail closed: never start serving without the session-encryption key.
    throw new Error(
      "SESSION_SECRET not resolved: set SESSION_SECRET (local/dev) or " +
        "SESSION_SECRET_ARN (AWS Secrets Manager).",
    );
  }

  // Resolve DB URL: local DATABASE_URL wins; else fetch from Secrets Manager at
  // runtime. The resulting string stays on the returned Env object only — we do
  // NOT write it to process.env so it can't leak through env-var exposure.
  const databaseUrl = await resolveDatabaseUrl();

  // WS-1 KV port provider wiring (§5). Default (unset) = "dynamodb": the typed
  // KvStore hot-spot namespaces resolve to DynamoKvStore over their byte-compat
  // layouts — existing AWS deployments see ZERO change. "postgres" builds a
  // small dedicated KV pool (bypassing the tenant-scoped Prisma pool) and
  // registers it so the same namespaces resolve to PostgresKvStore.
  //
  // MUST stay above the `kv()` helper below: the string-KV bindings now read
  // the same executor, and a `kv()` call that ran first would fail closed.
  const kvProvider = resolveKvProvider();
  if (kvProvider === "postgres") {
    setKvSqlExecutor(await makeKvSqlExecutor(databaseUrl));
  }

  const kvCursorSecret = sessionSecret || process.env.CURSOR_SECRET;
  // The 13 Cloudflare-compat string-KV bindings. These used to construct a
  // DynamoKv UNCONDITIONALLY while the typed `getKvStore()` honoured
  // KV_PROVIDER — a split-brain in which, on a Postgres deployment, the
  // invitation pre-signup record went to `kv_entries` and the invitation
  // session token went to a DynamoDB endpoint that does not resolve. Both
  // ports now follow the same switch. See lib/kv/postgres-kv-namespace.ts.
  const kv = (namespace: string): KVNamespace => {
    if (kvProvider === "postgres") {
      const executor = getKvSqlExecutor();
      if (executor === undefined) {
        // Fail closed, loudly. Serving with a silently-absent KV would disable
        // the invitation gate, CSRF-token validation and the session blocklist.
        throw new Error(
          `KV_PROVIDER=postgres but the KV SQL executor is not wired (buildEnv) for namespace=${namespace}`,
        );
      }
      return new PostgresKv(executor, { namespace });
    }
    return new DynamoKv(dynamoClient, {
      tableName: kvTableName,
      namespace,
      ...(kvCursorSecret ? { cursorSecret: kvCursorSecret } : {}),
    });
  };

  // Startup warning (not a boot failure — a missing security.txt is honest,
  // unlike the example.com placeholder it replaced): logged once, here,
  // because buildEnv() itself runs exactly once at boot (see server.ts).
  if (!process.env.AGENT_SURFACE_SECURITY_TXT) {
    console.warn(
      "[agent-surface] AGENT_SURFACE_SECURITY_TXT is not set — GET /security.txt will return 404. " +
        "Configure agentSurface.securityTxt (env var AGENT_SURFACE_SECURITY_TXT) to serve a real security contact.",
    );
  }

  return {
    // Realtime transport seam: resolveRealtimeEnv() reads the REALTIME_* vars
    // and selects the default (poll/noop) transport; Skybber overrides via
    // setRealtimeProvider() before serving.
    ...resolveRealtimeEnv(),
    // Media config seam: resolveMediaEnv() reads all MEDIA_* vars; no compiled
    // threshold values ship in the tarball (threshold-secrecy invariant).
    ...resolveMediaEnv(),
    // Directory-profile config seam (T3): NEIGHBORHOOD fuzz radius from
    // NEIGHBORHOOD_FUZZ_RADIUS_METERS. Namespaced to match the media/realtime
    // pattern (the resolver returns a bare config, unlike resolveMediaEnv()).
    directoryProfile: resolveDirectoryProfileConfig(),
    // Directory-search config seam (T4): pagination/rate-limit/timeout bounds
    // from DIRECTORY_SEARCH_* vars. Resolver already returns { directorySearch }.
    ...resolveDirectorySearchEnv(),
    // Email-subscription config seam (§6): resolveEmailSubscriptionEnv() reads
    // the numeric EMAIL_SUB_* vars only — the two required secrets are set
    // directly below (never through this resolver, so they stay out of
    // validateEnv()'s startup path).
    ...resolveEmailSubscriptionEnv(),
    // Collections config seam (§3): resolveCollectionEnv() reads COLLECTION_* vars.
    ...resolveCollectionEnv(),
    // Comment rate-limit seam (rule 8): reads COMMENT_RATE_LIMIT_* vars.
    ...resolveCommentRateLimitEnv(),
    // Events-primitive config seam (§4.8): resolveEventEnv() reads EVENT_* vars.
    ...resolveEventEnv(),
    // Provenance config seam (D15): reads PROVENANCE_* vars.
    ...resolveProvenanceEnv(),
    DATABASE_URL: databaseUrl,
    DATABASE_URL_CN: process.env.DATABASE_URL_CN,
    DIRECT_URL: process.env.DIRECT_URL,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
    DATABASE_POOL_MIN: process.env.DATABASE_POOL_MIN,
    DATABASE_CONNECTION_TIMEOUT_MS: process.env.DATABASE_CONNECTION_TIMEOUT_MS,
    // DB TLS (DP-7): pass-through; `lib/db-ssl.ts` interprets them.
    DB_SSL_CA: process.env.DB_SSL_CA,
    DB_SSL_CA_PATH: process.env.DB_SSL_CA_PATH,
    DATABASE_STATEMENT_TIMEOUT_MS: process.env.DATABASE_STATEMENT_TIMEOUT_MS,
    DATABASE_IDLE_TIMEOUT_MS: process.env.DATABASE_IDLE_TIMEOUT_MS,

    // Auth
    SESSION_SECRET: sessionSecret,
    SESSION_SECRET_FALLBACK: sessionSecretFallback,
    SESSION_SALT: process.env.SESSION_SALT,
    MFA_VERIFY_MAX_ATTEMPTS: process.env.MFA_VERIFY_MAX_ATTEMPTS,
    MFA_VERIFY_MAX_ATTEMPTS_PER_IP: process.env.MFA_VERIFY_MAX_ATTEMPTS_PER_IP,
    MFA_VERIFY_WINDOW_SECONDS: process.env.MFA_VERIFY_WINDOW_SECONDS,
    MFA_ENC_KEY: process.env.MFA_ENC_KEY,
    PUSH_TOKEN_ENC_KEY: process.env.PUSH_TOKEN_ENC_KEY,
    COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
    COGNITO_APP_CLIENT_ID: process.env.COGNITO_APP_CLIENT_ID,
    COGNITO_REGION: process.env.COGNITO_REGION || process.env.AWS_REGION || "us-east-1",
    COGNITO_HOSTED_UI_DOMAIN: process.env.COGNITO_HOSTED_UI_DOMAIN,
    COGNITO_REDIRECT_URI: process.env.COGNITO_REDIRECT_URI,

    // Generic OIDC verification (WS-3.1/3.3) — per manifest D8 (OIDC_* canonical);
    // additive, default-derived from COGNITO_*.
    OIDC_ISSUER_URL: process.env.OIDC_ISSUER_URL,
    OIDC_APP_CLIENT_ID: process.env.OIDC_APP_CLIENT_ID,
    OIDC_JWKS_URL: process.env.OIDC_JWKS_URL,
    IDENTITY_PROVIDER: process.env.IDENTITY_PROVIDER,
    IDENTITY_ADMIN_CLIENT_ID: process.env.IDENTITY_ADMIN_CLIENT_ID,
    IDENTITY_ADMIN_CLIENT_SECRET: process.env.IDENTITY_ADMIN_CLIENT_SECRET,

    // OAuth device-authorization adapter (T9b-d)
    COGNITO_AGENT_CLIENT_ID: process.env.COGNITO_AGENT_CLIENT_ID,
    DEVICE_AUTH_TABLE: process.env.DEVICE_AUTH_TABLE,
    DEVICE_AUTH_KMS_KEY_ID: process.env.DEVICE_AUTH_KMS_KEY_ID,
    PSEUDONYM_HMAC_KMS_KEY_ID: process.env.PSEUDONYM_HMAC_KMS_KEY_ID,
    AGENT_REFRESH_TABLE: process.env.AGENT_REFRESH_TABLE,
    IDEMPOTENCY_TABLE: process.env.IDEMPOTENCY_TABLE,
    RATE_LIMIT_TABLE: process.env.RATE_LIMIT_TABLE,
    RATE_LIMIT_NAMESPACE: process.env.RATE_LIMIT_NAMESPACE,
    AGENT_VERIFICATION_URI_BASE:
      process.env.AGENT_VERIFICATION_URI_BASE ||
      "https://example.com/agents/authorize",

    // Email-subscription REQUIRED secrets — raw passthrough only, no default,
    // no ARN/Secrets-Manager path. Absence is fine here (feature is off by
    // default); requireEmailSubHmacSecret()/requireEmailSubEncKey() throw
    // lazily when a handler needs them. NEVER derive these from SESSION_SECRET.
    EMAIL_SUB_HMAC_SECRET: process.env.EMAIL_SUB_HMAC_SECRET,
    EMAIL_SUB_ENC_KEY: process.env.EMAIL_SUB_ENC_KEY,

    // Supabase
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_URL_CN: process.env.SUPABASE_URL_CN,
    SUPABASE_PUBLISHABLE_KEY_CN: process.env.SUPABASE_PUBLISHABLE_KEY_CN,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,

    // Microsoft Entra
    ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID,
    ENTRA_CHINA_TENANT_ID: process.env.ENTRA_CHINA_TENANT_ID,
    INTERNAL_TENANT_ID: process.env.INTERNAL_TENANT_ID,

    // App config
    APP_DOMAIN: process.env.APP_DOMAIN,
    APP_URL: process.env.APP_URL,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    agentSurface: {
      llmsTxt: process.env.AGENT_SURFACE_LLMS_TXT,
      securityTxt: process.env.AGENT_SURFACE_SECURITY_TXT,
    },
    ACTIVITYPUB_BASE_URL: process.env.ACTIVITYPUB_BASE_URL,
    // Federation master switch — fail closed: anything other than the exact
    // string "true" leaves federation disabled.
    ACTIVITYPUB_ENABLED: process.env.ACTIVITYPUB_ENABLED === "true",
    ACTIVITYPUB_BLOCKED_DOMAINS: process.env.ACTIVITYPUB_BLOCKED_DOMAINS,
    ACTIVITYPUB_INSTANCE_RATE_LIMIT:
      process.env.ACTIVITYPUB_INSTANCE_RATE_LIMIT,
    ACTIVITYPUB_KEY_ENCRYPTION_KEY:
      process.env.ACTIVITYPUB_KEY_ENCRYPTION_KEY,
    ACTIVITYPUB_LEGACY_KEY_ENCRYPTION_KEY:
      process.env.ACTIVITYPUB_LEGACY_KEY_ENCRYPTION_KEY,
    ACTIVITYPUB_LEGACY_KEY_DECRYPT:
      process.env.ACTIVITYPUB_LEGACY_KEY_DECRYPT,

    // Client version policy — raw passthrough; boot validation (env-schema.ts)
    // has already rejected malformed values, and resolveVersionPolicy() treats
    // anything unparseable as "unset" (dormant) as defense in depth.
    CLIENT_MIN_SUPPORTED_VERSION: process.env.CLIENT_MIN_SUPPORTED_VERSION,
    CLIENT_RECOMMENDED_VERSION: process.env.CLIENT_RECOMMENDED_VERSION,
    CLIENT_STORE_URL_ANDROID: process.env.CLIENT_STORE_URL_ANDROID,
    CLIENT_STORE_URL_IOS: process.env.CLIENT_STORE_URL_IOS,

    // Trusted-proxy hint for client-IP derivation; defaults to "none".
    TRUSTED_PROXY: process.env.TRUSTED_PROXY,

    // CSP
    CSP_CONNECT_SRC: process.env.CSP_CONNECT_SRC,
    CSP_SCRIPT_SRC: process.env.CSP_SCRIPT_SRC,
    CSP_STYLE_SRC: process.env.CSP_STYLE_SRC,

    // Region
    IP_GEOLOCATION_API_KEY: process.env.IP_GEOLOCATION_API_KEY,
    IP_GEOLOCATION_SERVICE: process.env.IP_GEOLOCATION_SERVICE as "ipapi" | "ip-api" | "cloudflare" | undefined,
    DEFAULT_REGION: process.env.DEFAULT_REGION || "EU",
    ENABLE_IP_GEOLOCATION: process.env.ENABLE_IP_GEOLOCATION,
    INTERNAL_EMAIL_DOMAINS: process.env.INTERNAL_EMAIL_DOMAINS,

    // External APIs
    OPENAI_API_KEY: openaiApiKey,
    GOOGLE_SAFE_BROWSING_API_KEY: process.env.GOOGLE_SAFE_BROWSING_API_KEY,
    RECAPTCHA_SITE_KEY: process.env.RECAPTCHA_SITE_KEY,
    RECAPTCHA_SECRET_KEY: process.env.RECAPTCHA_SECRET_KEY,

    // Email
    EMAIL_SERVICE: (process.env.EMAIL_SERVICE as any) || "aws-ses",
    EMAIL_SERVICE_REGION: process.env.EMAIL_SERVICE_REGION,
    FROM_EMAIL: process.env.FROM_EMAIL,
    EMAIL_BRAND_NAME: process.env.EMAIL_BRAND_NAME,
    AWS_SES_REGION: process.env.AWS_SES_REGION || process.env.AWS_REGION || "us-east-1",
    SES_CONFIGURATION_SET: process.env.SES_CONFIGURATION_SET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    ALIBABA_ACCESS_KEY_ID: process.env.ALIBABA_ACCESS_KEY_ID,
    ALIBABA_ACCESS_KEY_SECRET: process.env.ALIBABA_ACCESS_KEY_SECRET,
    ALIBABA_REGION: process.env.ALIBABA_REGION,
    ALIBABA_ACCOUNT_NAME: process.env.ALIBABA_ACCOUNT_NAME,
    TENCENT_SECRET_ID: process.env.TENCENT_SECRET_ID,
    TENCENT_SECRET_KEY: process.env.TENCENT_SECRET_KEY,
    TENCENT_REGION: process.env.TENCENT_REGION,
    TENCENT_FROM_EMAIL: process.env.TENCENT_FROM_EMAIL,

    // Admin
    SECURITY_WEBHOOK_URL: process.env.SECURITY_WEBHOOK_URL,

    // --- P3 signup-metadata config (surveillance-hardening Phase 0, E2) ---
    SIGNUP_EVENT_RETENTION_DAYS: process.env.SIGNUP_EVENT_RETENTION_DAYS,
    // --- end P3 signup-metadata config ---

    // Cost protection
    OPENAI_BUDGET_ENABLED: process.env.OPENAI_BUDGET_ENABLED || "true",
    OPENAI_BUDGET_HOURLY_MAX: process.env.OPENAI_BUDGET_HOURLY_MAX || "500",
    OPENAI_BUDGET_DAILY_MAX: process.env.OPENAI_BUDGET_DAILY_MAX || "5000",
    COST_LIMIT_DAILY_TOTAL: process.env.COST_LIMIT_DAILY_TOTAL || "10",
    COST_LIMIT_DAILY_OPENAI: process.env.COST_LIMIT_DAILY_OPENAI || "5",
    COST_LIMIT_DAILY_SES: process.env.COST_LIMIT_DAILY_SES || "2",

    // Deployment
    ENVIRONMENT: process.env.ENVIRONMENT || process.env.NODE_ENV,
    DEPLOY_ENV: process.env.DEPLOY_ENV,
    APP_VERSION: process.env.APP_VERSION || "0.1.0",
    LOG_LEVEL: process.env.LOG_LEVEL,
    NODE_ENV: process.env.NODE_ENV,
    CI: process.env.CI,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    STAGE: stage,
    ENABLE_TEST_ROUTES: process.env.ENABLE_TEST_ROUTES,

    // AWS
    AWS_REGION: process.env.AWS_REGION,
    AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,

    // Cloudflare Images shim (no-op in AWS)
    IMAGES: undefined,

    // DynamoDB-backed KV namespaces
    RATE_LIMIT_KV: kv("ratelimit"),
    PRIVACY_PREFERENCES_KV: kv("privacy"),
    FEED_CACHE_KV: kv("feed"),
    MODERATION_CACHE_KV: kv("moderation"),
    COMMENTS_KV: kv("comments"),
    THREAT_INTEL_CACHE_KV: kv("threatintel"),
    TAXONOMY_CACHE_KV: kv("taxonomy"),
    FOLLOWERS_KV: kv("followers"),
    EXPORT_JOBS_KV: kv("export"),
    DELETE_JOBS_KV: kv("delete"),
    CSRF_TOKENS_KV: kv("csrf"),
    SESSION_BLOCKLIST_KV: kv("session"),
    INVITATIONS_KV: kv("invitations"),

    // SQS queues
    EXPORT_QUEUE: new SqsQueue(sqsClient, sqsUrl("user-export")),
    DELETE_ACCOUNT_QUEUE: new SqsQueue(sqsClient, sqsUrl("delete-account")),
    FOLLOWERS_EVENTS_QUEUE: new SqsQueue(sqsClient, sqsUrl("followers-events")),
    LINK_CHECK_QUEUE: new SqsQueue(sqsClient, sqsUrl("link-check")),
    MEDIA_PROCESSING_QUEUE: new SqsQueue(sqsClient, sqsUrl("media-processing")),
    // WS-2 §4 inversion flag — default OFF (zero AWS change; finding 1).
    MEDIA_ENQUEUE_ON_COMPLETE: process.env.MEDIA_ENQUEUE_ON_COMPLETE === "true",

    // S3 buckets (R2 interface)
    MEDIA_BUCKET_R2: new S3Storage(s3Client, mediaBucket),
    EXPORT_FILES_R2: new S3Storage(s3Client, exportsBucket),
    // The resolved name MEDIA_BUCKET_R2 wraps — single source for the
    // moderation ref bucket (see the Env field doc). Never re-derive elsewhere.
    MEDIA_BUCKET_NAME: mediaBucket,
  };
}
