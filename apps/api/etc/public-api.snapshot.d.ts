// ===== db.d.ts =====
import type { PrismaClient } from "@prisma/client";
export interface EnvWithDb {
    DATABASE_URL: string;
    LOG_LEVEL?: string;
    DATABASE_CONNECTION_TIMEOUT_MS?: string;
    DATABASE_STATEMENT_TIMEOUT_MS?: string;
}
export type ManagedPrismaClient = PrismaClient & {
    release: () => Promise<void>;
};
export declare function createPrisma(env: EnvWithDb, region?: string): ManagedPrismaClient;
export declare function withPrisma<T>(env: EnvWithDb, fn: (client: PrismaClient) => Promise<T>, region?: string): Promise<T>;
export declare function withPrismaRetry<T>(env: EnvWithDb, queryFn: (client: PrismaClient) => Promise<T>, options?: {
    region?: string;
    timeoutMs?: number;
    retryTimeoutMs?: number;
    maxRetries?: number;
    baseDelayMs?: number;
    defaultValue?: T;
    context?: Record<string, any>;
}): Promise<T>;
export declare function createPrismaForRegion(region: string, env: EnvWithDb): ManagedPrismaClient;
export declare class DatabaseClient {
    static clearPoolCache(): void;
    static getPoolStatus(): {
        key: string;
        totalCount: number;
        idleCount: number;
        waitingCount: number;
        age: number;
        errorCount: number;
    }[];
    static createForRegion(region: string, env: EnvWithDb): ManagedPrismaClient;
    static create(env: EnvWithDb, region?: string): ManagedPrismaClient;
}

// ===== env.d.ts =====
/**
 * Environment Configuration
 *
 * Builds the application environment from process.env + AWS service adapters.
 * Shaped to be compatible with the existing handler code that expects CF-style bindings.
 */
import { type ResolveContext } from "@de-otio/saas-foundation/secrets";
import type { KVNamespace, CloudflareQueue, R2Bucket, AnalyticsEngineDataset } from "./types/cloudflare-compat.js";
import type { NotificationType } from "@prisma/client";
import type { RealtimeTransport } from "./lib/realtime/index.js";
import type { DirectoryProfileConfig } from "./lib/org-category/directory-profile-config.js";
import type { DirectorySearchConfig } from "./lib/org-category/directory-search-config.js";
import type { DisclosurePosture } from "./lib/provenance/posture.js";
/** Application environment — available to all route handlers */
export interface Env {
    DATABASE_URL: string;
    DATABASE_URL_CN?: string;
    DIRECT_URL?: string;
    DATABASE_POOL_MAX?: string;
    DATABASE_POOL_MIN?: string;
    DATABASE_CONNECTION_TIMEOUT_MS?: string;
    DATABASE_STATEMENT_TIMEOUT_MS?: string;
    DATABASE_IDLE_TIMEOUT_MS?: string;
    SESSION_SECRET: string;
    SESSION_SECRET_FALLBACK?: string;
    SESSION_SALT?: string;
    COGNITO_USER_POOL_ID?: string;
    COGNITO_APP_CLIENT_ID?: string;
    COGNITO_REGION?: string;
    COGNITO_HOSTED_UI_DOMAIN?: string;
    COGNITO_REDIRECT_URI?: string;
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
     * If unset, the tombstone key falls back to the resolved SESSION_SECRET.
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
    SUPABASE_URL?: string;
    SUPABASE_PUBLISHABLE_KEY?: string;
    SUPABASE_URL_CN?: string;
    SUPABASE_PUBLISHABLE_KEY_CN?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    ENTRA_TENANT_ID?: string;
    ENTRA_CHINA_TENANT_ID?: string;
    INTERNAL_TENANT_ID?: string;
    APP_DOMAIN?: string;
    APP_URL?: string;
    ALLOWED_ORIGINS?: string;
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
    CSP_CONNECT_SRC?: string;
    CSP_SCRIPT_SRC?: string;
    CSP_STYLE_SRC?: string;
    IP_GEOLOCATION_API_KEY?: string;
    IP_GEOLOCATION_SERVICE?: "ipapi" | "ip-api" | "cloudflare";
    DEFAULT_REGION?: string;
    ENABLE_IP_GEOLOCATION?: string;
    INTERNAL_EMAIL_DOMAINS?: string;
    OPENAI_API_KEY?: string;
    GOOGLE_SAFE_BROWSING_API_KEY?: string;
    RECAPTCHA_SITE_KEY?: string;
    RECAPTCHA_SECRET_KEY?: string;
    EMAIL_SERVICE?: "aws-ses" | "resend" | "alibaba-directmail" | "tencent-ses" | "scaleway-tem" | "smtp";
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
    SECURITY_WEBHOOK_URL?: string;
    ANALYTICS?: AnalyticsEngineDataset;
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
    OPENAI_BUDGET_ENABLED?: string;
    OPENAI_BUDGET_HOURLY_MAX?: string;
    OPENAI_BUDGET_DAILY_MAX?: string;
    COST_LIMIT_DAILY_TOTAL?: string;
    COST_LIMIT_DAILY_OPENAI?: string;
    COST_LIMIT_DAILY_SES?: string;
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
    AWS_REGION?: string;
    AWS_ACCOUNT_ID?: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    IMAGES?: any;
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
    /**
     * Media upload/serve configuration. All operational thresholds come from
     * env vars; code ships only conservative safe-for-dev defaults.
     */
    media: {
        /**
         * Maximum file size in bytes per media type.
         * Sources: MEDIA_MAX_BYTES_IMAGE / MEDIA_MAX_BYTES_VIDEO / MEDIA_MAX_BYTES_AUDIO.
         */
        maxBytes: {
            image: number;
            video: number;
            audio: number;
        };
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
        rateLimits: {
            uploadPerMin: number;
            batchPerMin: number;
            servePerMin: number;
        };
        /**
         * Accepted MIME-type allowlists per media type.
         * Sources: MEDIA_ALLOWLIST_IMAGE_JSON / MEDIA_ALLOWLIST_VIDEO_JSON / MEDIA_ALLOWLIST_AUDIO_JSON
         * (JSON arrays). Defaults to narrow safe sets; consumer widens as needed.
         */
        allowlist: {
            image: string[];
            video: string[];
            audio: string[];
        };
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
        thresholds: Record<string, {
            review: number;
            quarantine: number;
        }>;
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
    directoryProfile: DirectoryProfileConfig;
    directorySearch: DirectorySearchConfig;
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
    collection: {
        /** Max items per collection. Source: COLLECTION_MAX_ITEMS. Default 25. */
        maxItems: number;
        /** Max collections per user. Source: COLLECTION_MAX_PER_USER. Default 50. */
        maxPerUser: number;
    };
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
}
/**
 * Track A — the RESERVED key-ring namespace. The client stores its wrapped-DEK
 * bundle under this namespace; the server is blind to it (opaque ciphertext, no
 * parsing). Always allowed, regardless of REALTIME_SETTING_NAMESPACES, so the
 * key-ring works even when no other setting sync is opted in.
 */
export declare const KEYRING_NAMESPACE = "__keyring";
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
export declare function resolveRealtimeEnv(): {
    features: {
        realtimeTransport: "poll" | "appsync-events";
        realtimePush: boolean;
    };
    REALTIME_REENGAGEMENT_TYPES: ReadonlySet<NotificationType>;
    REALTIME_SETTING_NAMESPACES: string[];
    REALTIME_SETTING_MAX_BYTES: number;
    REALTIME_CONN_LOG_RETENTION_DAYS: number;
    realtimeTransport: RealtimeTransport;
};
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
export declare function resolveMediaEnv(): {
    media: {
        maxBytes: {
            image: number;
            video: number;
            audio: number;
        };
        maxPixels: number;
        rateLimits: {
            uploadPerMin: number;
            batchPerMin: number;
            servePerMin: number;
        };
        allowlist: {
            image: string[];
            video: string[];
            audio: string[];
        };
        presets: string[];
        thresholds: Record<string, {
            review: number;
            quarantine: number;
        }>;
        canonicalFormat: "jpeg" | "png" | "webp";
        canonicalQuality: number;
        maxDurationSeconds: number;
        reviewRateCap: number;
        uploadQuota: {
            maxObjects: number;
            maxBytes: number;
        };
        transcribe: {
            outputBucket?: string;
            languageCode: string;
        };
        presignExpirySeconds: number;
    };
};
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
export declare function parseMediaThresholds(raw: string | undefined): Record<string, {
    review: number;
    quarantine: number;
}>;
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
export declare function resolveEmailSubscriptionEnv(source?: NodeJS.ProcessEnv): {
    emailSubscription: {
        confirmTokenTtlHours: number;
        pendingTtlHours: number;
        suppressionDays: number;
        confirmedRetentionDays: number;
        ratePerIpPerHour: number;
        ratePerTargetPerHour: number;
        ratePerEmailPerHour: number;
    };
};
/**
 * Resolve the collections config block from `source` (defaults to
 * `process.env`; tests can inject a fixture object).
 *
 * Threshold-secrecy seam (CLAUDE.md rule 8): the cap is runtime config, never
 * a compiled constant, so no number ships in the public tarball. Design:
 * open-social-web/03-collections.md §3.
 */
export declare function resolveCollectionEnv(source?: NodeJS.ProcessEnv): {
    collection: {
        maxItems: number;
        maxPerUser: number;
    };
};
/**
 * Resolve the comment rate-limit config block (threshold-secrecy, rule 8).
 *
 * Single-writer: the ONLY place that reads COMMENT_RATE_LIMIT_* env vars. The
 * defaults reproduce the previous compiled-in behaviour exactly (10/min, 30s
 * per-post cooldown) so this is a config seam, not a policy change — except
 * `failMode`, which deliberately flips: see the middleware for why.
 */
export declare function resolveCommentRateLimitEnv(source?: NodeJS.ProcessEnv): {
    commentRateLimit: {
        perMinute: number;
        postCooldownSeconds: number;
        failMode: "closed" | "open";
    };
};
/**
 * Resolve the synthetic-content provenance config block (AI Act Art. 50, D15).
 *
 * Single-writer: the ONLY place that reads PROVENANCE_* env vars. An
 * unrecognised posture string resolves to {@link DEFAULT_DISCLOSURE_POSTURE}
 * rather than throwing — see the field doc on `Env.provenance`.
 */
export declare function resolveProvenanceEnv(source?: NodeJS.ProcessEnv): {
    provenance: {
        defaultDisclosurePosture: DisclosurePosture;
    };
};
/**
 * Resolve the events-primitive config block from `source` (defaults to
 * `process.env`; tests can inject a fixture object).
 *
 * Single-writer: this is the ONLY place that reads the EVENT_* env vars.
 * Threshold-secrecy seam (CLAUDE.md rule 8): every value is runtime config with
 * a CONSERVATIVE dev-safe fallback, never a compiled constant sprinkled at call
 * sites. Design: plans/events-primitive/README.md §4.8.
 */
export declare function resolveEventEnv(source?: NodeJS.ProcessEnv): {
    event: {
        maxPerTenant: number;
        maxShiftsPerEvent: number;
        maxGuestsPerRsvp: number;
        rsvpRatePerHour: number;
        updateRatePerHour: number;
        updateNotifyCooldownSeconds: number;
        listPageMax: number;
    };
};
/** S1.4 — Validate critical environment variables at startup */
export declare function validateEnv(env: Env): string[];
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
export declare function requireEmailSubHmacSecret(env: Env): string;
/**
 * Require EMAIL_SUB_ENC_KEY — the base64-encoded 32-byte KEK for
 * email-subscription field encryption (`emailEnc`) — and decode it. Mirrors
 * `resolveKek()` in `lib/oauth/envelope-crypto.ts` (DEVICE_AUTH_KEK_BASE64):
 * absence or a wrong-length decode both throw.
 *
 * Lazily required, same as `requireEmailSubHmacSecret()` — not checked at
 * startup, never falls back to another secret.
 */
export declare function requireEmailSubEncKey(env: Env): Buffer;
/**
 * Build the application environment — fetches secrets from AWS if needed.
 *
 * @param context optional foundation `ResolveContext` for secret resolution.
 *   Production passes nothing (default AWS clients + cache). Tests inject a
 *   `MemorySecretStore`'s clients to exercise the Secrets Manager path
 *   deterministically without hitting AWS.
 */
export declare function buildEnv(context?: ResolveContext): Promise<Env>;

// ===== extensions.d.ts =====
/**
 * Extension Registry
 *
 * Manages registered extensions. Extensions are registered at startup
 * by the application entry point (server.ts), not statically imported here.
 * This keeps the core free of extension-specific dependencies.
 */
import type { TrellisExtension } from "@de-otio/trellis-extension-api";
/** Register an extension. Call at startup before the server starts. */
export declare function registerExtension(ext: TrellisExtension): void;
/** Look up an extension by entity type */
export declare function getExtension(entityType: string): TrellisExtension | undefined;
/** Return all registered extensions */
export declare function getExtensions(): readonly TrellisExtension[];

// ===== index.d.ts =====
/**
 * @de-otio/trellis — Public API
 *
 * Verticals import from this module to register extensions and start the server.
 */
export { startServer } from "./server.js";
export { registerExtension, getExtension, getExtensions } from "./extensions.js";
export { shutdownTrellis } from "./shutdown.js";
export type { ShutdownResult } from "./shutdown.js";
export { EXTENSION_API_VERSION } from "@de-otio/trellis-extension-api";
export { classifyApiVersion, parseApiVersion } from "./lib/extension-validator.js";
export type { ApiVersionVerdict, ParsedApiVersion } from "./lib/extension-validator.js";
export { setRealtimeProvider } from "./lib/realtime/index.js";
export { setPushTransportProvider } from "./lib/push/index.js";
export type { PushTransport, PushDeviceTarget, PushSendOutcome, PushPlatformWire, } from "./lib/push/index.js";
export { setMediaModerationProvider } from "./lib/media/request-moderation.js";
export { setMediaLabelPolicy } from "./lib/media/request-moderation.js";
export { createLabelPolicy, LabelPolicyConfigError } from "./lib/media/label-policy.js";
export type { LabelPolicy, LabelPolicyConfig, LabelPolicyContext, CategoryPolicy, TaxonomyPinMode, } from "./lib/media/label-policy.js";
export { setMediaReviewPromotion } from "./lib/media/media-review-handler.js";
export type { ReviewPromotionPort, ReviewPromoteCoords } from "./lib/media/media-review-handler.js";
export { ModerationMetrics } from "./lib/media/moderation-metrics.js";
export type { ModerationMetricsConfig, ModerationMetricsSnapshot, ModerationPublicHealth, } from "./lib/media/moderation-metrics.js";
export { FrameSamplingVideoModerationAdapter } from "./lib/media/frame-sampling-adapter.js";
export type { FrameSamplingConfig, FrameSamplingDeps } from "./lib/media/frame-sampling-adapter.js";
export { withModerationDeadline, ModerationDeadlineConfigError, } from "./lib/media/moderation-deadline.js";
export { createMediaBytesAccess, MediaBytesTooLargeError } from "./lib/media/media-bytes-access.js";
export type { MediaBytesAccess } from "./lib/media/media-bytes-access.js";
export { ModerationProviderError, isModerationProviderError, NullModerationProvider, assertModerationProviderAllowed, moderationProviderName, UNKNOWN_PROVIDER_NAME, } from "./lib/media/moderation-provider.js";
export type { MediaModerationProvider, MediaPin, ImageRef, S3Ref, ModerationVerdict, ModerationLabel, ModerationCallOptions, VideoModerationStart, } from "./lib/media/moderation-provider.js";
export { completionEnvelopeBody, parseCompletionEnvelope, } from "./lib/media/completion-envelope.js";
export type { ModerationCompletionEnvelope } from "./lib/media/completion-envelope.js";
export { setTextModerationProvider } from "./lib/media/request-text-moderation.js";

// ===== lib/audit-composer.d.ts =====
/**
 * Audit composer (phase 1.C.2).
 *
 * Trellis-side facade over `@de-otio/saas-foundation/audit`. Replaces
 * the old `AuditLogger` (data lifecycle) and `AuditEventEmitter`
 * (tenant / IdP) with a single composition point that:
 *
 *   1. Applies trellis's default-DENY allowlist (`filterPayload`) +
 *      IP anonymisation (`anonymizeIp`) to event metadata BEFORE the
 *      event reaches foundation. (LOCKED: keep the allowlist.)
 *   2. Hands the scrubbed event to foundation's `AuditLog`, which is
 *      configured with foundation's `PiiFilter` (denylist) as a
 *      SECOND, additive layer. (LOCKED: denylist is additive, not a
 *      replacement.)
 *   3. Persists via `PostgresAuditStore` over a region-resolved Prisma
 *      client. Retention tiers: info=30, warning=90, error=365 days.
 *      (LOCKED.)
 *
 * Frozen-type crossing: this module is the first trellis consumer of
 * the frozen `AuditEvent` / `AuditAction` vocabulary. Future changes to
 * the emitted shape go through the frozen-type RFC process.
 *
 * Severity collapse (trellis 4-tier -> foundation 3-tier):
 *   low + medium -> info     (30d)
 *   high         -> warning  (90d)
 *   critical     -> error    (365d)
 *
 * ── SECURITY-SENSITIVE READ CONVENTION ───────────────────────────────
 *
 * Any BULK, CROSS-USER, or EXPORT read of user data MUST emit an audit
 * event. An audit trail cannot be backfilled — if the read is not
 * recorded at the time it occurs, it is permanently invisible to
 * compliance reviews.
 *
 * Worked example — admin bulk-export of user records:
 *
 *   await auditLogger.logDataAccess({
 *     action: DATA_READ,
 *     resource:    "user",
 *     resourceId:  `bulk:${requestedCount}`,
 *     userId:      session.userId,          // the requesting admin's ID
 *     region:      detectedRegion,
 *     success:     true,
 *     metadata: {
 *       targetType: "user_export",
 *       reason:     "compliance_request",
 *     },
 *   }, env);
 *
 * Scope of the rule:
 *   - Covered NOW:  mutations (data.create / update / delete), auth,
 *     feature_toggle.changed, tenant / IdP events.
 *   - Deferred:     individual single-user reads (low priority).
 *   - IN SCOPE for the research platform: any research.query,
 *     research.extract, experiment.assign operation.
 *
 * See doc/02-technical/development/audit-and-toggle-conventions.md for
 * naming conventions, prefix rules, and the research.query PII rule.
 */
import type { AuditAction, AuditEvent } from "@de-otio/saas-foundation/audit";
import { type EnvWithDb } from "../db.js";
import { type Region } from "./region-detection.js";
export type TrellisSeverity = "low" | "medium" | "high" | "critical";
/**
 * Anything with an `auditEvent.create` method. The real Prisma client
 * (`ManagedPrismaClient`), the structural `PrismaAuditClient`, and test
 * mocks all satisfy this. Foundation's `PostgresAuditStore` requires the
 * narrower `PrismaAuditClient`; Prisma's generated `create` is more
 * generic than (and so not structurally assignable to) foundation's
 * narrow shape, so we accept the broad type at the boundary and cast
 * once inside `getAuditLog`. The cast is runtime-safe — the column
 * names foundation writes match the generated `AuditEvent` model.
 */
export type AuditPrismaClientLike = {
    readonly auditEvent: {
        create: (...args: never[]) => unknown;
    };
};
export type TrellisAuditEventType = "data_access" | "data_create" | "data_update" | "data_delete" | "user_action" | "authentication" | "authorization" | "region_change";
export interface TrellisAuditEvent {
    type?: TrellisAuditEventType;
    action: string;
    resource: string;
    resourceId?: string;
    userId?: string;
    region: Region;
    dataRegion?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
    severity?: TrellisSeverity;
    success: boolean;
}
export interface TrellisAuditLoggerEnv extends EnvWithDb {
    DEFAULT_REGION?: string;
}
/**
 * `TrellisAuditLogger` — drop-in for the old `AuditLogger`. Region-aware
 * (resolves a Prisma client per region), best-effort (never throws into
 * the caller), and validates region before emitting (invalid-region
 * events are dropped, as before).
 */
export declare class TrellisAuditLogger {
    private readonly requestId?;
    constructor(_env?: TrellisAuditLoggerEnv, requestId?: string | undefined);
    withRequestId(requestId: string): TrellisAuditLogger;
    logDataAccess(event: Omit<TrellisAuditEvent, "type" | "severity"> & {
        type?: TrellisAuditEventType;
        severity?: TrellisSeverity;
    }, env: TrellisAuditLoggerEnv): Promise<void>;
    logUserAction(event: Omit<TrellisAuditEvent, "type" | "severity"> & {
        type?: TrellisAuditEventType;
        severity?: TrellisSeverity;
    }, env: TrellisAuditLoggerEnv): Promise<void>;
    logAuthentication(event: Omit<TrellisAuditEvent, "type" | "severity"> & {
        type?: TrellisAuditEventType;
        severity?: TrellisSeverity;
    }, env: TrellisAuditLoggerEnv): Promise<void>;
    logAuthorization(event: Omit<TrellisAuditEvent, "type" | "severity"> & {
        type?: TrellisAuditEventType;
        severity?: TrellisSeverity;
    }, env: TrellisAuditLoggerEnv): Promise<void>;
    /** Generic entry point — accepts a full trellis event. */
    log(event: Omit<TrellisAuditEvent, "severity"> & {
        severity?: TrellisSeverity;
    }, env: TrellisAuditLoggerEnv): Promise<void>;
    /**
     * Emit a system-level event where the `action` string is passed directly
     * to the foundation audit log (bypassing the coarse `actionFor()` mapping).
     *
     * Use for platform-control actions like `feature_toggle.changed`,
     * `consent.changed`, `experiment.assign` that have their own dedicated
     * action constant and should not be collapsed to a coarse `data.*` label.
     *
     * The `action` parameter MUST be a known `AuditAction` constant from
     * `audit-actions.ts`; do not pass free-form strings.
     *
     * Best-effort — never throws into the caller.
     */
    logSystemAction(action: AuditAction, event: Omit<TrellisAuditEvent, "type" | "action" | "severity"> & {
        severity?: TrellisSeverity;
    }, env: TrellisAuditLoggerEnv): Promise<void>;
    private emitDirect;
    private emit;
}
/** Factory — drop-in for the old `createAuditLogger`. */
export declare function createAuditLogger(env?: TrellisAuditLoggerEnv, requestId?: string): TrellisAuditLogger;
/** Input shape preserved from the old `AuditEventEmitter.emit`. */
export interface TenantAuditEmitInput {
    type: AuditAction;
    tenantId: string;
    actorUserId: string;
    payload: Record<string, unknown>;
    /** Source IP — anonymised to /24 (v4) or /64 (v6) before storage. */
    sourceIp?: string;
    /** Present when made through an agent session. */
    agentSessionId?: string;
}
/**
 * `TenantAuditEmitter` — replaces the CloudWatch+Postgres
 * `AuditEventEmitter`. CloudWatch is dropped (foundation owns the sink);
 * the Postgres write now goes through foundation's `AuditLog` /
 * `PostgresAuditStore`. Signature `emit(input, prismaClient)` is
 * preserved so the four consumers change only their import.
 *
 * Tenant/IdP events are tenant-scoped (`actor.kind = "user"`,
 * `tenantId` set) and default to `info` severity (matching the old
 * "medium" -> info collapse).
 */
export declare class TenantAuditEmitter {
    emit(input: TenantAuditEmitInput, prisma: AuditPrismaClientLike): Promise<void>;
}
export type { AuditEvent };

// ===== lib/extension-model-registry.d.ts =====
/**
 * Composed extension-model registry (O-1 design §12.3, Q8 item 4).
 *
 * The single generated source of truth for the extension-owned (`ext_*`) models
 * present in the composed schema. Three consumers agree on this contract:
 *
 * - **L1** feeds every entry's `model` into `TENANT_SCOPED_MODELS` so the
 *   scoped proxy enforces isolation and the `tenant-scope.test.ts` coverage
 *   tripwire stays green.
 * - **L2** (the fragment composer) GENERATES this array from the merged
 *   fragments — it is the "allowlist derived from the composed schema".
 * - **L4** iterates it for GDPR erasure: models with a non-null
 *   `erasureSubjectField` join the per-subject `deleteMany` sequence.
 *
 * **Empty today by design.** The only extension (`@skybber/ext-dogs`) owns no
 * Prisma tables yet — it is routes + taxonomy seeds. O-1 is infrastructure
 * ahead of its first table-owner (lane-02). L2 will emit entries here once a
 * fragment declares models.
 */
/**
 * A scalar FK column on a composed model whose tenant-ownership is validated
 * read-before-write by the scoped proxy (O-1 design §1 L1(i); security F3/B4).
 * Structurally identical to `ScopedFkField` in extension-scoped-db.ts — kept a
 * distinct declaration here to avoid a circular import (scoped-db imports this
 * module, not vice versa).
 */
export interface ExtensionModelFkField {
    /** The scalar FK column on THIS model, e.g. "entityId". */
    readonly field: string;
    /** The referenced model's Prisma delegate key (camelCase), e.g. "entity". */
    readonly targetModel: string;
    /** The tenant column on the TARGET model (conventionally "tenantId"). */
    readonly targetTenantField: string;
}
/**
 * One composed extension-owned model, as needed by isolation + erasure.
 */
export interface ExtensionModelRegistryEntry {
    /** Prisma model name (camelCase delegate key), e.g. "dogReminder". */
    readonly model: string;
    /** The mandatory tenant column injected on every scoped op, e.g. "tenantId". */
    readonly tenantField: string;
    /**
     * The column identifying the GDPR data subject for per-subject erasure, or
     * `null` when the model is `none-personal` / `cascade-only` (design §6).
     */
    readonly erasureSubjectField: string | null;
    /**
     * FK scalars whose target tenant-ownership is validated on create/update/upsert
     * (security F3/B4). Omitted/empty ⇒ no FK-tenant check for this model. A FK to a
     * per-SUBJECT model (`User`) does NOT belong here — that is an erasure linkage,
     * not a tenant check (see `CORE_FK_ALLOWLIST` in extension-scoped-db.ts).
     */
    readonly fkFields?: readonly ExtensionModelFkField[];
}
/**
 * The composed registry — the compiled-in DEFAULT. Empty by design (no extension
 * owns tables at build time). The runtime ACTIVE registry is injected at boot by
 * the consuming app via {@link setExtensionModelRegistry} (see below); this const
 * remains the fallback when nothing is injected.
 */
export declare const EXTENSION_MODEL_REGISTRY: readonly ExtensionModelRegistryEntry[];
/**
 * Inject the composed extension-model registry at boot. MUST be called before
 * {@link freezeExtensionModelRegistry} (i.e. before the HTTP listener binds) —
 * `startServer` freezes automatically. Throws if called after freezing.
 */
export declare function setExtensionModelRegistry(entries: readonly ExtensionModelRegistryEntry[]): void;
/**
 * Freeze the registry so it can never change while requests are served. Called
 * by `startServer` immediately before binding the listener.
 */
export declare function freezeExtensionModelRegistry(): void;
/** The active registry — the injected one if set, else the empty default. */
export declare function getExtensionModelRegistry(): readonly ExtensionModelRegistryEntry[];
/**
 * TEST-ONLY reset of the boot injection state. Not part of the public contract;
 * exists so unit tests can exercise set/freeze in isolation.
 */
export declare function __resetExtensionModelRegistryForTest(): void;

// ===== lib/extension-validator.d.ts =====
/**
 * Extension Validator
 *
 * Validates extension registrations at startup:
 * - Extension IDs are valid format and not reserved
 * - No duplicate IDs
 * - The declared `extensionApiVersion` is compatible with core's
 *   `EXTENSION_API_VERSION` (absent ⇒ one warning, incompatible ⇒ fail boot)
 * - Routes don't shadow core endpoints
 * - Warns about routes without auth middleware
 */
import { type TrellisExtension } from "@de-otio/trellis-extension-api";
/**
 * Hard length cap applied BEFORE any regex touches the input. Bounding the
 * input, not just the pattern, is what keeps a hostile or accidentally huge
 * string from becoming a matcher problem at all.
 */
export declare const MAX_API_VERSION_LENGTH = 64;
/** A parsed `major.minor.patch` triple. Suffixes are already discarded. */
export interface ParsedApiVersion {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
}
/**
 * Parse a version string under the bounded rule above. Pure and total: any
 * input at all yields either a triple or `null` — never a throw.
 */
export declare function parseApiVersion(raw: unknown): ParsedApiVersion | null;
/**
 * The verdict for one extension's declared API version. A closed union so the
 * caller must handle every case, and so the decision itself stays a pure
 * function that can be unit-tested without booting anything.
 */
export type ApiVersionVerdict = 
/** No declaration — warn once at boot, never fatal. */
{
    readonly kind: "absent";
}
/** Declared, but not a version string under the bounded rule — fatal. */
 | {
    readonly kind: "unparseable";
    readonly raw: unknown;
}
/** Core's own constant is malformed — a core packaging bug; fatal. */
 | {
    readonly kind: "core-unparseable";
    readonly core: string;
}
/** Outside the compatibility window — fatal. */
 | {
    readonly kind: "incompatible";
    readonly declared: string;
    readonly core: string;
    readonly reason: string;
}
/** Inside the compatibility window but not identical — log only. */
 | {
    readonly kind: "drift";
    readonly declared: string;
    readonly core: string;
}
/** Same compatibility window and same triple — silent. */
 | {
    readonly kind: "match";
};
/**
 * Decide how an extension's declared API version relates to core's.
 *
 * Compatibility rule (mirrors the bump policy documented on
 * `EXTENSION_API_VERSION`): a differing MAJOR is always breaking; while the
 * API is still `0.x` a differing MINOR is breaking too, because 0.x minors
 * carry signature changes. Anything else is drift.
 *
 * `core` is a parameter rather than a module constant so the malformed-core
 * branch is reachable in tests.
 */
export declare function classifyApiVersion(declaredRaw: unknown, core: string): ApiVersionVerdict;
/**
 * Validate every registered extension. Throws on the first fatal problem —
 * callers (`server.ts`) treat a throw as "do not serve".
 *
 * @param coreApiVersion core's extension-API version; defaults to the shipped
 *   `EXTENSION_API_VERSION` constant and is only overridden by tests.
 */
export declare function validateExtensions(extensions: TrellisExtension[], coreApiVersion?: string): void;

// ===== lib/logger.d.ts =====
/**
 * Trellis-side adapter around `@de-otio/saas-foundation/logger`.
 *
 * Foundation owns the runtime logger (pino-backed, structured,
 * AsyncLocalStorage-aware). Trellis call-sites use a positional-arg
 * shape — `logger.error("message", data)` — that pre-dates the
 * cutover. This module preserves that shape so the cutover stays
 * mechanical (a 400-site singleton-call → `getLogger()` codemod,
 * nothing more) while delegating to foundation underneath.
 *
 * When foundation's request-context module is in scope (i.e. inside
 * `runWithRequestContext`), `getLogger()` resolves to the
 * request-scoped logger that carries `requestId`/`tenantId`/etc.
 * outside scope, it returns foundation's root logger. Hardening
 * the entrypoint set so every getLogger() call has an active
 * RequestContext is a follow-up — keeping the fallback today
 * avoids a 400-site coordination problem.
 */
export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";
export interface LoggerEnv {
    LOG_LEVEL?: string;
    NODE_ENV?: string;
}
/**
 * Trellis logger shape — positional `(message, data?)` calls.
 * Internally delegates to foundation's pino-style logger; `data`,
 * when present, is wrapped into a structured payload (`{ err }` for
 * Error instances, the object itself for plain objects, `{ data }`
 * for primitives).
 */
export interface Logger {
    error(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    debug(message: string, data?: unknown): void;
    trace(message: string, data?: unknown): void;
}
/**
 * Get a request-scoped logger. Returns the foundation root logger
 * when called outside a `runWithRequestContext` scope (the same
 * fallback shape the singleton `getLogger()` provided).
 */
export declare function getLogger(): Logger;
/**
 * Generate a unique request ID for log correlation. Used by code
 * paths that need a stable correlator before a RequestContext exists.
 */
export declare function generateRequestId(): string;

// ===== lib/media/completion-envelope.d.ts =====
/**
 * completion-envelope.ts — the provider-neutral shape a moderation backend
 * publishes when an async job finishes, plus a total parser for it.
 *
 * WHY A CANONICAL SHAPE. The completion queue used to speak exactly one
 * vendor's wire format, which meant "implement the moderation seam" quietly
 * also meant "emit that vendor's notification JSON". The canonical envelope is
 * the small, documented thing an adapter can actually produce:
 *
 *     { "track": "VISUAL" | "AUDIO", "jobId": "<the id you returned>" }
 *
 * The historical shapes still parse (see {@link parseCompletionEnvelope}), so a
 * backend already publishing them keeps working and in-flight messages are not
 * stranded by a deploy.
 *
 * THE ENVELOPE IS UNTRUSTED, AND `track` IS THE SHARP EDGE. Anything that can
 * write to the queue chooses this JSON, so `track` is a ROUTING HINT and never
 * an authority. The worker resolves the job row by `jobId` and compares the
 * claimed track against the row's own track; a mismatch is unroutable and is
 * dropped WITHOUT claiming the dedupe key — because claiming it would let a
 * forged message burn the dedupe slot that the genuine completion needs, and a
 * completion that can be pre-emptively silenced is a completion that can be
 * made to never arrive. The body's own verdict fields, if any, are ignored
 * entirely: only the job id survives parsing.
 *
 * PURE AND TOTAL: no I/O, no clock, no throw, for any input at all.
 */
import type { Track } from "./track-verdict.js";
/**
 * The parsed pointer: which track finished, and the provider job id to re-fetch
 * authoritative state with. Deliberately carries nothing else.
 */
export interface ModerationCompletionEnvelope {
    readonly track: Track;
    readonly jobId: string;
}
/**
 * Bound and de-fang a provider-supplied string before it reaches a log line, a
 * metric dimension, or a database lookup. Strips C0/C1 control characters
 * (including the newlines that would forge log records) and truncates.
 */
export declare function sanitizeProviderString(value: string): string;
/**
 * Parse an untrusted completion body into a canonical envelope.
 *
 * Resolution order, and why:
 *
 *  1. **Canonical wins.** If the body carries a `track` field at all, the
 *     message is treated as canonical: a valid track plus a usable `jobId`
 *     parses, and anything else about it (an unknown track, a missing id)
 *     returns `null` rather than falling through. A message that ALSO carries
 *     legacy fields is therefore unambiguous — it cannot be steered down the
 *     compat path by adding a second job id under a different key.
 *  2. **Compat fallbacks**, for backends still publishing their native
 *     notification shapes: an audio transcription job name (directly or under
 *     an event-envelope `detail`), then a visual job id (directly or inside a
 *     notification's JSON-string `Message`).
 *
 * Returns `null` for anything unrecognised. The caller drops such a message
 * rather than retrying it — a permanently-malformed pointer that is retried is
 * a message that loops until it reaches a dead-letter queue, and nothing about
 * re-reading the same bytes will make them parse.
 */
export declare function parseCompletionEnvelope(body: string): ModerationCompletionEnvelope | null;
/**
 * Build the canonical body an adapter should publish. Exported so a provider
 * implementor has an exact, testable target instead of a prose description, and
 * so core's own tests round-trip against the same producer the docs point at.
 */
export declare function completionEnvelopeBody(envelope: ModerationCompletionEnvelope): string;

// ===== lib/media/frame-sampling-adapter.d.ts =====
/**
 * frame-sampling-adapter.ts — video moderation for an IMAGE-ONLY classifier.
 *
 * The moderation seam asks a backend for three things, and the third — a video
 * job model with its own start/poll lifecycle and its own completion
 * notification — is the one most classifiers do not have. This adapter supplies
 * it in core: given any provider that can classify a still image, it samples
 * frames out of a video, classifies each, and aggregates the results under the
 * law in ./frame-aggregation.ts.
 *
 * RESOLVES INLINE, ON PURPOSE. `startVideoModeration` does the whole job and
 * returns `initialDecision` alongside the job id. There is no remote job to
 * poll and no completion message will ever arrive, so the caller persists the
 * decision immediately (the same mechanism a silent video's audio track already
 * uses) rather than waiting for a notification that is not coming. Two
 * consequences, stated rather than discovered later:
 *
 *   - Sampling time is spent inside the CALLER's budget — for the media
 *     pipeline, the processing worker's. It is bounded by `maxFramesPerJob`
 *     times the per-frame classifier call, plus the extraction itself.
 *   - The job id is core-minted and carries no tenant, key, or user material:
 *     it is crypto-random, because an id that encodes what it points at is an
 *     id that leaks what it points at wherever ids are logged.
 *
 * CLEANUP covers every frame this adapter is TOLD about: success, ceiling
 * breach, classifier error, abort. The one gap is an extractor that writes
 * frames and then throws without reporting their paths — core cannot delete
 * files it never learned of, so the port makes that the adapter's
 * responsibility and core logs the prefix.
 *
 * FAIL-CLOSED AT EVERY EDGE. No sampling config, no `sampleFrames` capability,
 * a ceiling breach, an extraction shortfall, an aborted deadline, a classifier
 * that throws — every one of them resolves `review`. Nothing in this file can
 * produce `approved` except a complete set of frames that each approved.
 */
import type { LabelPolicy } from "./label-policy.js";
import type { TranscodePort } from "./media-ports.js";
import type { ImageRef, MediaModerationProvider, ModerationCallOptions, ModerationVerdict, S3Ref, VideoModerationStart } from "./moderation-provider.js";
/**
 * Sampling parameters. Both moderation-relevant values are operator-supplied
 * with NO compiled default — absence means the feature refuses to run, which is
 * why they are optional in the type but fatal at use.
 */
export interface FrameSamplingConfig {
    /** Frames sampled per second of video. Operator-supplied; no default. */
    readonly framesPerSecond?: number;
    /** Absolute ceiling on frames for one job. Operator-supplied; no default. */
    readonly maxFramesPerJob?: number;
    /**
     * The pipeline's duration cap, passed through to the extractor so a single
     * clip cannot make it run unbounded. Operator-supplied (Env.media); absence
     * refuses the job rather than guessing a bound.
     */
    readonly maxDurationSeconds?: number;
    /**
     * How many frames to classify concurrently. A RESOURCE bound, not a
     * moderation parameter — it trades wall-clock against provider rate limits
     * and says nothing about policy — so it has a conservative code default.
     */
    readonly frameConcurrency?: number;
    /**
     * An operator-chosen name for this sampling policy, recorded on every job.
     *
     * When absent, a FINGERPRINT of the effective parameters is used instead: a
     * short digest that changes if and only if the policy changed. That is the
     * property an audit needs ("was this scanned under the policy we think?"),
     * and it is available with no operator action, so the audit trail is never
     * simply empty. It does NOT conceal the parameters — see
     * {@link policyFingerprint} — so it is server-side-only material either way.
     */
    readonly policyVersion?: string;
}
/** Logging seam; the worker already has one of this shape. */
export interface FrameSamplingLog {
    info?: (msg: string, data?: Record<string, unknown>) => void;
    warn?: (msg: string, data?: Record<string, unknown>) => void;
    error?: (msg: string, data?: Record<string, unknown>) => void;
}
export interface FrameSamplingDeps {
    /** The image-only classifier this adapter turns into a video classifier. */
    readonly images: MediaModerationProvider;
    /**
     * The operator's label policy, applied to EVERY frame.
     *
     * Without it the video path would honour the provider's own per-frame
     * decision while the image path honoured the operator's policy — so the
     * policy's strongest rule ("a category you have not mapped quarantines")
     * would hold for a still and not for the same content inside a clip. An
     * operator who configures a policy reasonably believes it governs both.
     *
     * The policy can only degrade a frame's verdict, so wiring it can never make
     * the video path more permissive than the provider already was.
     */
    readonly policy?: LabelPolicy;
    /** Frame extraction + per-frame cleanup. */
    readonly transcode: TranscodePort;
    readonly config: FrameSamplingConfig;
    /**
     * Where frames for a job are written. Returns a storage prefix; the transcode
     * adapter writes the numbered frames beneath it and reports their keys back.
     */
    readonly frameDirFor: (jobId: string) => string;
    /**
     * Mints the core-side job id. Injected so the adapter stays free of ambient
     * randomness in tests; production passes a crypto-random generator.
     */
    readonly newJobId: () => string;
    readonly log?: FrameSamplingLog;
}
export declare class FrameSamplingVideoModerationAdapter implements MediaModerationProvider {
    private readonly deps;
    private readonly resolved;
    constructor(deps: FrameSamplingDeps);
    /**
     * The underlying classifier's name, passed through unchanged. This adapter
     * supplies a video JOB MODEL; it does not classify anything itself, so it is
     * not a separate provider identity. A getter rather than a copied field so a
     * provider that names itself lazily is still reported correctly.
     */
    get name(): string | undefined;
    /**
     * Who to attribute an AGGREGATE verdict to: the classifier that actually
     * scored the frames, falling back to this adapter only when that classifier
     * reports no name.
     *
     * Not {@link PROVIDER_NAME} unconditionally. `"frame-sampling"` is the same
     * string for every classifier, so attributing scored verdicts to it collides
     * every backend into one identity — which defeats a per-provider cache key
     * and makes per-provider counters meaningless. It would also disagree with
     * what {@link name} reports, and a verdict field that contradicts the
     * provider's own name leaves two sets of counters with nothing to say which
     * is right.
     *
     * The REFUSAL verdicts are deliberately not routed through here: when core
     * declines to sample at all, no classifier ran, and `"frame-sampling"` is the
     * honest answer to who produced that verdict.
     */
    private scoredAttribution;
    /** Images pass straight through to the underlying classifier. */
    moderateImage(input: ImageRef, options?: ModerationCallOptions): Promise<ModerationVerdict>;
    /**
     * Sample, classify, aggregate — all of it, now. Returns the minted job id
     * together with the decision it already reached.
     */
    startVideoModeration(input: S3Ref, options?: ModerationCallOptions): Promise<VideoModerationStart>;
    /**
     * Poll. For a job this adapter minted, the answer was already known at start
     * and persisted by the caller; this returns the cached verdict when the poll
     * happens in the same process, and fails closed to `review` otherwise. It
     * NEVER invents an approval for an id it does not recognise.
     */
    getVideoModeration(jobId: string, _options?: ModerationCallOptions): Promise<ModerationVerdict>;
    private remember;
    private resolveVideo;
    /**
     * Classify each frame, at most `frameConcurrency` at a time. A frame whose
     * classification throws — or that is reached after the caller's deadline
     * aborted — contributes `null`, which the aggregation law counts as `review`.
     */
    private classifyFrames;
    private cleanup;
}

// ===== lib/media/label-policy.d.ts =====
/**
 * label-policy.ts — pure functional core: turn a provider's labels into one of
 * the three decisions, under an operator-supplied policy.
 *
 * This is the module that decides whether media is approved, so it is written
 * to be readable as a safety argument rather than as a lookup table:
 *
 *  1. **It refuses to exist without a policy.** {@link createLabelPolicy}
 *     throws when the category map is missing. There is no compiled-in default
 *     map and no default confidence bar — this file ships in a public npm
 *     tarball, and a threshold compiled into it is a published threshold. An
 *     operator who configures nothing gets a hard failure at wiring time, not a
 *     silent policy nobody chose.
 *  2. **An unmapped category quarantines.** A category the operator has not
 *     ruled on is not a category to shrug at: the provider is reporting
 *     something and the policy has no opinion, which is precisely when a human
 *     should look. It dominates — one unmapped label quarantines the object
 *     however benign every other label is.
 *  3. **Approval requires a verifiable taxonomy.** A category→action map is
 *     only meaningful against the taxonomy it was written for. If the provider
 *     silently reships its model under the same category names, the map keeps
 *     "working" while meaning something else. So under the pinned modes the
 *     verdict must carry a `modelVersion` that matches what the operator
 *     pinned; drift or absence degrades to `review`. Pin failure FLOORS the
 *     decision at review — it never lifts a quarantine.
 *  4. **No labels is not automatically approval.** Zero labels approves only
 *     when the pin verified. A provider that returns an empty label array
 *     because it errored internally, or because its taxonomy moved, must not
 *     be able to approve by saying nothing.
 *  5. **The policy can only ever DEGRADE the provider's verdict.** The result
 *     is floored at what the provider itself said, so a policy can turn an
 *     `approved` into a `review` and never the reverse.
 *
 *     This one is load-bearing and easy to get wrong, because the natural
 *     implementation — derive a decision from the labels and return it — is
 *     wrong in a way that inverts the whole pipeline. A provider that hits an
 *     internal fault does what the seam contract REQUIRES: it returns
 *     `{ decision: "review", labels: [] }`. Interpreting that from labels alone
 *     yields "no labels, pin fine, therefore approved" — the fail-closed
 *     verdict becomes an approval, and the fail-closed Null provider approves
 *     everything. Some verdicts are also not expressible as labels at all (a
 *     hash match, a rate-limit refusal), and those must survive interpretation
 *     untouched.
 *
 * PURITY: no I/O, no clock, no randomness, and no numbers of its own.
 */
import type { ModerationDecision } from "./media-lifecycle.js";
import type { ModerationVerdict } from "./moderation-provider.js";
/**
 * How the taxonomy behind the category map is pinned.
 *
 * - `"response"` — the provider must REPORT a `modelVersion` on every verdict,
 *   and when the caller knows which version a job started under (video: the
 *   version captured at job start) it must still match at completion. Detects
 *   a mid-job taxonomy change.
 * - `"config"` — the operator names the exact version their category map was
 *   written for. Any other version, or none, is drift.
 * - `"none"` — no taxonomy pin. Requires an explicit opt-in, and the resulting
 *   policy carries a standing {@link LabelPolicy.unpinnedTaxonomy} flag so the
 *   operations surface can show the posture continuously. A boot-time log line
 *   would not do: nobody re-reads boot logs, and this is a condition that
 *   persists for as long as the deployment does.
 */
export type TaxonomyPinMode = "response" | "config" | "none";
/** Confidence boundaries for one opaque category token. */
export interface CategoryPolicy {
    /** At or above this confidence, the category means `review`. */
    readonly review: number;
    /** At or above this confidence, the category means `quarantine`. */
    readonly quarantine: number;
}
/**
 * The operator-supplied policy. Every value here comes from runtime config
 * (env/SSM/feature toggles); none of it has a default in this file.
 *
 * `categories` maps the provider's OPAQUE category tokens to confidence bars.
 * The tokens and the bars must be expressed on the same scale the provider
 * reports confidences on — core never rescales, because a rescale is a policy
 * decision disguised as arithmetic.
 */
export interface LabelPolicyConfig {
    readonly categories: Readonly<Record<string, CategoryPolicy>>;
    readonly pinMode: TaxonomyPinMode;
    /** The pinned taxonomy version. REQUIRED when `pinMode` is `"config"`. */
    readonly expectedModelVersion?: string;
    /** Must be explicitly `true` when `pinMode` is `"none"`. */
    readonly acceptUnpinnedTaxonomy?: boolean;
}
/** Thrown at wiring time when the policy is unusable. Never thrown per-verdict. */
export declare class LabelPolicyConfigError extends Error {
    constructor(message: string);
}
/** Context the caller knows that the verdict itself does not. */
export interface LabelPolicyContext {
    /**
     * The taxonomy version recorded when this job STARTED, for the async video
     * path. Under `"response"` mode a completion whose version differs from the
     * one the job began under is drift, even though both are self-reported.
     */
    readonly pinnedModelVersion?: string;
}
export interface LabelPolicy {
    /** Interpret one verdict. Total: never throws, for any verdict shape. */
    decide(verdict: ModerationVerdict, context?: LabelPolicyContext): ModerationDecision;
    /**
     * True when this policy runs WITHOUT a taxonomy pin. A standing flag for the
     * operations surface, not a one-shot log line.
     */
    readonly unpinnedTaxonomy: boolean;
}
/**
 * Build a policy, or refuse.
 *
 * Refuses when: there is no category map at all; `pinMode` is unrecognised;
 * `"config"` mode names no version; or `"none"` mode was requested without the
 * explicit `acceptUnpinnedTaxonomy: true`. An EMPTY category map is allowed and
 * is not the same as a missing one — it is a coherent policy meaning "every
 * category the provider can report is unmapped, so quarantine all of them" —
 * but a `categories` that is absent or not an object is a wiring mistake.
 */
export declare function createLabelPolicy(config: LabelPolicyConfig): LabelPolicy;
/**
 * The decision function itself, exported for direct table-driven testing.
 *
 * Total by construction: a malformed verdict (null, no labels array, a label
 * with a non-numeric confidence) yields at worst `review`, never `approved`.
 */
export declare function decideFromLabels(verdict: ModerationVerdict, config: LabelPolicyConfig, context?: LabelPolicyContext): ModerationDecision;

// ===== lib/media/media-bytes-access.d.ts =====
/**
 * media-bytes-access.ts — hand a moderation adapter the BYTES it needs without
 * handing it storage credentials.
 *
 * Some classifiers do not read from object storage at all: they take an image
 * in the request body. Wiring one of those up used to mean giving the adapter
 * its own storage client and its own credentials — a second identity with read
 * access to every piece of user media, living in a consuming application's
 * config, for the sake of one HTTP POST.
 *
 * This capability closes that gap. Core reads the object through the storage
 * port it already holds and passes a Buffer to the adapter. The adapter needs
 * no credentials, no bucket name, and no knowledge of where media lives.
 *
 * TWO BOUNDS, both load-bearing:
 *
 *  - A SIZE CAP. The adapter names a key; core reads it. Without a cap, an
 *    adapter (or anything that can influence which key it asks for) could make
 *    a worker pull a multi-gigabyte object into memory. The read is RANGED to
 *    the cap plus one byte, so an oversize object is detected by what came back
 *    rather than by trusting a size the store reported.
 *  - PIN PASS-THROUGH. When the ref carries a pin, the read is pinned to it, so
 *    the adapter classifies the exact bytes the pipeline recorded rather than
 *    whatever currently sits at the key.
 */
import type { StoragePort } from "./media-ports.js";
import type { MediaPin } from "./moderation-provider.js";
/** Raised when the object is larger than the configured cap. */
export declare class MediaBytesTooLargeError extends Error {
    readonly maxBytes: number;
    constructor(maxBytes: number);
}
export declare class MediaBytesAccessConfigError extends Error {
    constructor();
}
/**
 * The capability handed to a provider adapter at injection time.
 *
 * Deliberately minimal: one method, one direction, no bucket handle and no way
 * to write, delete, or list. An adapter holding this can read the object it was
 * asked to classify and nothing else.
 */
export interface MediaBytesAccess {
    /**
     * Read the object a ref points at, up to the configured cap.
     *
     * @throws {@link MediaBytesTooLargeError} when the object exceeds the cap.
     */
    read(ref: {
        readonly key: string;
        readonly pin?: MediaPin;
    }): Promise<Buffer>;
    /** The cap, so an adapter can refuse early rather than provoke a throw. */
    readonly maxBytes: number;
}
export declare function createMediaBytesAccess(storage: StoragePort, config: {
    readonly maxBytes: number;
}): MediaBytesAccess;

// ===== lib/media/media-lifecycle.d.ts =====
/**
 * Media lifecycle: the ONE consolidated state machine for a media object
 * (T14/AR4). Replaces the former split between the Prisma `ModerationStatus`
 * enum + the `uploadStatus` string column (and the ad-hoc "orphan" reasoning
 * layered on top): one union, one event vocabulary, one pure total
 * `nextLifecycle()` function.
 *
 * This module is the **hand-written source of truth** for the lifecycle
 * states. It deliberately has **zero dependency on the Prisma-generated
 * client** so the serve gate and worker code can compile in worktrees that
 * have not regenerated the client. The Prisma `enum MediaLifecycle` mirrors
 * {@link MediaLifecycle} exactly; the imperative shell maps
 * `Prisma.MediaFile.lifecycle -> this union` at the I/O boundary.
 *
 * Pure functional core: no I/O, no clock, no Prisma import. Exhaustively
 * property-tested.
 *
 * Deliberately NOT part of the lifecycle (see prisma/schema.prisma):
 *  - `hidden` / `deletedAt` — reversible visibility + deletion audit; folding
 *    them in would destroy the moderation verdict on unhide. The serve gate
 *    (serve-gate.ts) combines them: APPROVED && !hidden && deletedAt == null.
 *  - `attachedToPost` / `orphanedAt` — attachment bookkeeping for orphan GC,
 *    orthogonal to upload/moderation.
 */
/**
 * The lifecycle state of a media object, persisted as `MediaFile.lifecycle`.
 * Hand-written source of truth — the Prisma enum must match this union
 * member-for-member.
 *
 * - `AWAITING_UPLOAD` — born here (presigned session issued; bytes not yet
 *                       confirmed). Nothing serves; nothing moderates.
 * - `UPLOADED`        — bytes confirmed in staging (S3 event pickup or the
 *                       client completion call, whichever lands first);
 *                       moderation pending/in-flight. Never serves.
 * - `APPROVED`        — the ONLY state that may serve bytes (with the
 *                       serve-gate's !hidden && !deleted checks).
 * - `REVIEW`          — classifier uncertain / pipeline poison; awaiting a
 *                       human moderator. Never serves.
 * - `QUARANTINED`     — classifier flagged it; awaiting a human moderator.
 * - `REJECTED`        — terminal; never serves. Includes over-duration
 *                       rejections and confirmed-CSAM.
 * - `UPLOAD_FAILED`   — terminal; the upload never became a moderatable
 *                       object (presign expired, abandoned, or reaped).
 */
export type MediaLifecycle = "AWAITING_UPLOAD" | "UPLOADED" | "APPROVED" | "REVIEW" | "QUARANTINED" | "REJECTED" | "UPLOAD_FAILED";
/**
 * The 3-value classifier verdict (the `decision` field of a moderation
 * provider's result). This is intentionally **not** 4-value: `rejected` is a
 * lifecycle *status* a human (or the CSAM provider) produces, never a
 * classifier decision.
 */
export type ModerationDecision = "approved" | "review" | "quarantine";
/**
 * Events that drive a `lifecycle` transition.
 *
 * - `bytes-arrived`  — the staged object's existence was confirmed: either the
 *                      processing worker picked up the S3 OBJECT_CREATED event
 *                      or the client's completion call HEAD-verified the
 *                      object. Idempotent on `UPLOADED` (the two signals race
 *                      benignly); NEVER legal from a moderation-resolved state
 *                      (a replayed S3 event must not rewind a verdict).
 * - `decision`       — the classifier/worker verdict on an `UPLOADED` object.
 * - `human`          — a human moderator resolving REVIEW/QUARANTINED.
 * - `csam`           — a confirmed hit from the separate (statutory) CSAM
 *                      provider; drives `-> REJECTED` from *any* state, with
 *                      the preserve-and-report duty handled by the shell.
 * - `over-duration`  — the authoritative post-upload ffprobe gate: the clip
 *                      exceeds the configured duration cap. Terminal reject;
 *                      the shell deletes the staged bytes BEFORE moderation.
 * - `upload-failed`  — the session expired / was abandoned / was reaped
 *                      before the object became moderatable.
 */
export type MediaLifecycleEvent = {
    readonly kind: "bytes-arrived";
} | {
    readonly kind: "decision";
    readonly decision: ModerationDecision;
} | {
    readonly kind: "human";
    readonly action: "approve" | "reject";
} | {
    readonly kind: "csam";
} | {
    readonly kind: "over-duration";
} | {
    readonly kind: "upload-failed";
};
/**
 * A transition that the state machine refuses. Returned (never thrown) so the
 * machine stays a pure total function and callers must handle the illegal case
 * explicitly — an illegal transition must **never** silently no-op into
 * `APPROVED`.
 */
export type IllegalTransition = {
    readonly ok: false;
    readonly reason: "illegal-transition";
    readonly from: MediaLifecycle;
    readonly event: MediaLifecycleEvent;
};
/** A successful transition to a next lifecycle state. */
export type TransitionResult = {
    readonly ok: true;
    readonly status: MediaLifecycle;
} | IllegalTransition;
/**
 * The pure media lifecycle state machine.
 *
 * Transitions (everything else is an {@link IllegalTransition}):
 *
 * ```
 * AWAITING_UPLOAD    --bytes-arrived-->        UPLOADED
 * AWAITING_UPLOAD    --upload-failed-->        UPLOAD_FAILED
 * UPLOADED           --bytes-arrived-->        UPLOADED    (idempotent no-op)
 * UPLOADED           --decision approved-->    APPROVED
 * UPLOADED           --decision review-->      REVIEW
 * UPLOADED           --decision quarantine-->  QUARANTINED
 * UPLOADED           --over-duration-->        REJECTED
 * UPLOADED           --upload-failed-->        UPLOAD_FAILED  (stuck-pipeline reap)
 * REVIEW|QUARANTINED --human approve-->        APPROVED
 * REVIEW|QUARANTINED --human reject-->         REJECTED
 * (any)              --csam-->                 REJECTED    (terminal; from any state)
 * ```
 *
 * Invariants (property-tested):
 * - `APPROVED`, `REJECTED`, and `UPLOAD_FAILED` are absorbing under non-CSAM
 *   events.
 * - A CSAM event drives any state to `REJECTED`.
 * - `QUARANTINED`/`REJECTED` never reach `APPROVED` without a human approve.
 * - A `decision` is never legal from `AWAITING_UPLOAD` — unconfirmed bytes
 *   cannot acquire a verdict.
 * - `bytes-arrived` never leaves the {AWAITING_UPLOAD, UPLOADED} pair — a
 *   replayed S3 event cannot rewind a resolved verdict.
 * - An illegal transition is reported, never coerced to `APPROVED`.
 *
 * @param current the current persisted lifecycle state
 * @param event   the driving event
 */
export declare function nextLifecycle(current: MediaLifecycle, event: MediaLifecycleEvent): TransitionResult;
/**
 * Map a classifier {@link ModerationDecision} to the {@link MediaLifecycle} an
 * `UPLOADED` object should land in — a thin shell over {@link nextLifecycle}
 * for the synchronous image-upload path (whose rows are created directly at
 * the resolved verdict, bytes + verdict being known atomically).
 *
 * Drives the transition `UPLOADED --decision <d>--> status` and returns the
 * resulting status. The transition out of UPLOADED on a `decision` event is
 * always legal, but should the machine ever report a not-ok transition we fail
 * closed to `REVIEW` (never `APPROVED`): an unexpected refusal must degrade to
 * human review, not to serving.
 */
export declare function decisionToStatus(decision: ModerationDecision): MediaLifecycle;
/** All lifecycle states, for exhaustive iteration in tests and the shell. */
export declare const ALL_MEDIA_LIFECYCLES: readonly MediaLifecycle[];
/** All classifier decisions, for exhaustive iteration in tests and the shell. */
export declare const ALL_MODERATION_DECISIONS: readonly ModerationDecision[];
/**
 * The moderation-phase subset of the lifecycle (what the former
 * `ModerationStatus` enum covered). Kept as a NAMED SUBSET (not a separate
 * machine) for shells that must map old persisted values or provider
 * vocabularies. `PENDING` intentionally does not exist any more — its two
 * meanings were split into `AWAITING_UPLOAD` and `UPLOADED`.
 */
export declare const MODERATION_RESOLVED_LIFECYCLES: readonly MediaLifecycle[];

// ===== lib/media/media-ports.d.ts =====
export interface TranscodeVideoInput {
    readonly inputPath: string;
    readonly outputPath: string;
    readonly posterPath: string;
    /** Hard cap on accepted duration; injected from Env.media (never a literal). */
    readonly maxDurationSeconds: number;
}
export interface TranscodeVideoResult {
    readonly cleanedPath: string;
    readonly posterPath: string;
    readonly durationSeconds: number;
    /**
     * Whether the cleaned output carries an audio stream. A video with no audio
     * (a silent clip, a screen recording, a GIF-style mp4) has nothing to
     * transcribe — the shell skips the AUDIO speech-to-text job and resolves the
     * AUDIO track as vacuously approved (no audio ⇒ no audio content to be
     * unsafe), instead of starting a transcription that would fail and fail the
     * track closed to REVIEW forever. The adapter reports this from a probe of
     * the produced output (NOT a guess); the shell never inspects bytes itself.
     */
    readonly hasAudio: boolean;
}
export interface TranscodeAudioInput {
    readonly inputPath: string;
    readonly outputPath: string;
    /** Hard cap on accepted duration; injected from Env.media (never a literal). */
    readonly maxDurationSeconds: number;
}
export interface TranscodeAudioResult {
    readonly cleanedPath: string;
    readonly durationSeconds: number;
}
/**
 * A request to extract still frames from a video.
 *
 * Both numbers are OPERATOR-SUPPLIED and arrive as arguments (never literals in
 * this public tarball):
 *
 * - `framesPerSecond` — how densely to sample.
 * - `maxFrames` — an ABSOLUTE ceiling on frames for this one job, independent
 *   of `framesPerSecond × duration`. It is a cost and disk bound, not a
 *   sampling preference: without it a long clip at a high rate turns one upload
 *   into an unbounded number of paid classifier calls and an unbounded number
 *   of temp files. The adapter must never emit more than `maxFrames`.
 *
 * The adapter writes frames to `outputDir` and returns their paths. Emitted
 * frames must carry NO inherited metadata (the container dictionary strip that
 * the transcode argv applies) — a sampled frame is a derivative of user media
 * and must not resurrect the GPS coordinates the transcode removed.
 */
export interface SampleFramesInput {
    readonly inputPath: string;
    readonly outputDir: string;
    readonly framesPerSecond: number;
    readonly maxFrames: number;
    /** Hard cap on accepted duration; injected from Env.media (never a literal). */
    readonly maxDurationSeconds: number;
}
export interface SampleFramesResult {
    /** Paths of the extracted frames, in temporal order. Never longer than `maxFrames`. */
    readonly framePaths: ReadonlyArray<string>;
}
export interface TranscodePort {
    /** Probe the duration of an input without transcoding it. */
    probeDurationSeconds(inputPath: string): Promise<number>;
    /** Re-encode a video to a clean form and emit a poster frame. */
    transcodeVideo(input: TranscodeVideoInput): Promise<TranscodeVideoResult>;
    /** Re-encode audio to a clean form. */
    transcodeAudio(input: TranscodeAudioInput): Promise<TranscodeAudioResult>;
    /**
     * Extract still frames for frame-sampled video moderation.
     *
     * OPTIONAL, so an existing consumer adapter still satisfies this interface —
     * this is a published package and a required method would be a breaking
     * change (same reasoning as `MediaPersistencePort.recordEmbeddedProvenance`).
     * The consequence is stated rather than hidden: frame-sampled moderation
     * REFUSES to run without it and fails the visual track closed to `review`.
     * It never degrades to "moderate nothing and approve".
     *
     * IF THIS THROWS, the adapter owns whatever it already wrote. Core deletes
     * the frames it is TOLD about, and a rejected call reports none — so an
     * extractor that fails partway must clean its own `outputDir` before
     * throwing. These are stills of media that may be about to be quarantined,
     * and core cannot delete files it never learned the names of.
     */
    sampleFrames?(input: SampleFramesInput): Promise<SampleFramesResult>;
    /**
     * Delete a previously-extracted frame. Called on EVERY path — success,
     * classifier error, deadline, ceiling breach — so sampled stills never
     * outlive the decision they informed. Must tolerate an already-absent file.
     *
     * OPTIONAL for the same published-package reason; when absent the adapter is
     * responsible for its own `outputDir` lifecycle, and core says so in a log
     * line rather than assuming cleanup happened.
     */
    deleteFrame?(framePath: string): Promise<void>;
}
export interface StoragePort {
    /** Read an object. `options.versionId` pins the read to that EXACT stored
     * version (AR-SEC F3) — S3 `GetObject` with `VersionId`.
     *
     * `options.range` reads only `[start, end]` INCLUSIVE (S3 `Range:
     * bytes=start-end`). Added for the Art. 50 provenance sniff on video/audio
     * originals, which must inspect a few hundred bytes of a possibly
     * hundreds-of-megabytes object and must not pull the whole thing into a
     * worker's memory to do it. An implementation MAY return fewer bytes than
     * requested (short object) but must never return more. */
    getObject(key: string, options?: {
        versionId?: string;
        range?: {
            readonly start: number;
            readonly end: number;
        };
    }): Promise<Buffer>;
    putObject(key: string, body: Buffer, contentType: string): Promise<void>;
    /** Copy an object. `options.fromVersionId` pins the SOURCE to that exact
     * version (AR-SEC F3) — on S3 a versioned `CopySource`; without it the
     * CURRENT bytes at `fromKey` are copied (TOCTOU-prone for moderated media —
     * the media pipeline always pins). */
    copyObject(fromKey: string, toKey: string, options?: {
        fromVersionId?: string;
    }): Promise<void>;
    deleteObject(key: string): Promise<void>;
    /**
     * Existence check. Without options: reports the CURRENT object, and — when
     * the backing store is versioned (S3 bucket versioning, REQUIRED on the
     * media bucket for the moderation pipeline's version pinning, AR-SEC F3) —
     * its current `versionId`; `versionId` is `undefined` on an unversioned
     * store (the pipeline fails closed on that). With `options.versionId`:
     * whether that exact version exists.
     */
    headObject(key: string, options?: {
        versionId?: string;
    }): Promise<{
        exists: boolean;
        versionId?: string;
        /**
         * Object size in bytes, when the adapter reports it (S3 `HeadObject`
         * `ContentLength`). OPTIONAL so an existing consumer adapter still satisfies
         * this interface. Used by the Art. 50 provenance sniff to locate the TAIL
         * range of a video original; when absent the sniff simply skips the tail read
         * and inspects the head slice only.
         */
        size?: number;
    }>;
}
export type TranscriptionStatus = "COMPLETED" | "FAILED" | "IN_PROGRESS";
export interface TranscribePort {
    startTranscription(input: {
        key: string;
        jobName: string;
    }): Promise<{
        jobId: string;
    }>;
    /**
     * Poll a transcription job.
     *
     * **No model echo, deliberately absent rather than forgotten.** Transcription
     * APIs commonly return only the text and a usage figure — one checked backend
     * returns exactly `{ text, usage }` — with no identifier for the model that
     * produced it. So there is nothing here to pin a model version *against*.
     *
     * The consequence for whoever designs the audio lane: the audio leg's version
     * pin can only ever be REQUEST-side — you record what you asked for, not what
     * answered. That is strictly weaker than the visual path, where a provider
     * reports `modelVersion` on its verdict and a pinned label policy floors an
     * unverifiable version at `review`. A request-side pin cannot detect a silent
     * vendor-side model swap, which is the exact failure a response-side pin
     * exists to catch.
     *
     * Do not add a `modelVersion` field here expecting a backend to fill it, and
     * do not treat a request-side record as equivalent to the visual pin when
     * reasoning about taxonomy drift on this track.
     */
    getTranscription(jobId: string): Promise<{
        status: TranscriptionStatus;
        transcript?: string;
    }>;
}
/**
 * In-memory TranscodePort. Returns programmable durations and echoes the
 * requested output/poster paths back, so the shell's path-plumbing can be
 * asserted without invoking a real encoder.
 *
 * Determinism: a single `duration` (default 0) is returned by `probe` and by
 * both transcode calls unless overridden. `transcodeVideo`/`transcodeAudio`
 * never themselves enforce `maxDurationSeconds` — duration policy lives in the
 * functional core (a separate caps unit), and the mock must not silently make
 * that decision for it.
 */
export declare class MockTranscodePort implements TranscodePort {
    private duration;
    private hasAudio;
    /**
     * How many frames extraction ACTUALLY yields, when that differs from what
     * (rate × duration, capped) asks for — the shortfall case a real decoder hits
     * on a partly-undecodable clip. `undefined` means "yield what was asked for".
     */
    private extractableFrames?;
    /** Records of each call, for assertions. */
    readonly probeCalls: string[];
    readonly videoCalls: TranscodeVideoInput[];
    readonly audioCalls: TranscodeAudioInput[];
    readonly sampleCalls: SampleFramesInput[];
    /** Frame paths passed to `deleteFrame`, in call order — cleanup assertions. */
    readonly deletedFrames: string[];
    constructor(opts?: {
        duration?: number;
        hasAudio?: boolean;
    });
    /** Program a partial extraction: only this many frames actually decode. */
    setExtractableFrames(count: number | undefined): void;
    /** Program the duration returned by subsequent calls. */
    setDuration(seconds: number): void;
    /** Program whether `transcodeVideo` reports an audio stream. */
    setHasAudio(hasAudio: boolean): void;
    probeDurationSeconds(inputPath: string): Promise<number>;
    transcodeVideo(input: TranscodeVideoInput): Promise<TranscodeVideoResult>;
    transcodeAudio(input: TranscodeAudioInput): Promise<TranscodeAudioResult>;
    /**
     * Deterministic frame extraction: yields `expectedFrameCount(duration, rate,
     * maxFrames)` paths under `outputDir`, or fewer when `setExtractableFrames`
     * programmed a partial decode. Never exceeds `maxFrames` — a mock that could
     * would let a ceiling bug pass its own test.
     */
    sampleFrames(input: SampleFramesInput): Promise<SampleFramesResult>;
    deleteFrame(framePath: string): Promise<void>;
}
/**
 * In-memory StoragePort backed by a Map, modelling a VERSIONED bucket
 * (AR-SEC F3): every put appends a new deterministic version
 * (`mock-version-N`), reads/copies may pin a version, and a delete hides the
 * current object behind a delete marker while prior versions stay resolvable
 * by versionId — mirroring S3 bucket-versioning semantics, which the media
 * pipeline's version pinning requires. `getObject` throws on a miss (callers
 * must handle the miss explicitly — a silent empty buffer would mask bugs).
 */
export declare class MockStoragePort implements StoragePort {
    private readonly objects;
    private versionSeq;
    constructor(seed?: Record<string, Buffer>);
    private appendVersion;
    /** The CURRENT (latest, non-delete-marked) version of a key, if any. */
    private current;
    getObject(key: string, options?: {
        versionId?: string;
        range?: {
            readonly start: number;
            readonly end: number;
        };
    }): Promise<Buffer>;
    putObject(key: string, body: Buffer, contentType: string): Promise<void>;
    copyObject(fromKey: string, toKey: string, options?: {
        fromVersionId?: string;
    }): Promise<void>;
    deleteObject(key: string): Promise<void>;
    headObject(key: string, options?: {
        versionId?: string;
    }): Promise<{
        exists: boolean;
        versionId?: string;
        size?: number;
    }>;
    /** Test helper: read the content-type a key was stored with. */
    contentTypeOf(key: string): string | undefined;
}
/**
 * In-memory TranscribePort. By default a started job is immediately COMPLETED
 * with an empty transcript; callers program per-job results via `setResult`.
 * Job ids are a deterministic monotonic sequence.
 */
export declare class MockTranscribePort implements TranscribePort {
    private seq;
    private readonly results;
    /** Records of each start call, for assertions. */
    readonly startCalls: {
        key: string;
        jobName: string;
    }[];
    startTranscription(input: {
        key: string;
        jobName: string;
    }): Promise<{
        jobId: string;
    }>;
    /** Program the result a given job id will report. */
    setResult(jobId: string, result: {
        status: TranscriptionStatus;
        transcript?: string;
    }): void;
    getTranscription(jobId: string): Promise<{
        status: TranscriptionStatus;
        transcript?: string;
    }>;
}

// ===== lib/media/media-review-handler.d.ts =====
/**
 * Media REVIEW-queue moderator handler (T9) — the imperative shell.
 *
 * Exposes the platform-MODERATOR surface over media awaiting a human decision:
 *   - list()        — paginated queue of REVIEW/QUARANTINED media, with the
 *                     per-track (visual/audio→transcript) verdicts from
 *                     MediaModerationJob surfaced for video items.
 *   - decide()      — apply a human approve/reject through the pure lifecycle
 *                     state machine (nextLifecycle `human` event); approve lands
 *                     APPROVED (servable) IFF the CAS object is present, reject
 *                     lands REJECTED. Every decision writes an AuditEvent.
 *   - escalateCsam()— STUB: drives the item to REJECTED via the `csam` event,
 *                     LOCKS it (hidden=true), and writes a CRITICAL audit row
 *                     flagged for human paging. NO automated reporting — the
 *                     statutory NCMEC/BKA path is handled by a human out-of-band.
 *
 * Design: functional-core / imperative-shell. The lifecycle decision is the
 * pure `nextLifecycle` machine; this shell only performs the I/O the machine
 * reports, and NEVER re-implements the transition inline. Role enforcement is
 * SERVER-SIDE and DB-authoritative (the caller resolves the role from the
 * session's userId against the User table — never a client claim); the pure
 * predicate `isModeratorRole` lives here so both the shell and its tests share
 * one definition.
 *
 * Every method takes its `db` (Prisma-like) and `auditLogger` explicitly so the
 * unit tests inject mocks — no module-level Prisma coupling.
 */
import { type MediaLifecycle } from "./media-lifecycle.js";
import type { StoragePort } from "./media-ports.js";
import { type PromoteLog } from "./promote-staging.js";
import type { Region } from "../region-detection.js";
import type { TrellisAuditLogger, TrellisAuditLoggerEnv } from "../audit-composer.js";
/**
 * The platform roles permitted on the media review surface. MODERATOR is the
 * purpose-built role (schema comment: "moderation-queue access"); SUPER_ADMIN is
 * a strict superset and is also allowed. Every other role — including END_USER —
 * is denied 403 by the shell. This is the ONE place the allow-set is defined.
 */
export declare const MODERATOR_ROLES: readonly ["MODERATOR", "SUPER_ADMIN"];
/**
 * Pure role predicate. `role` is the value read from `User.role` (server-side);
 * a null/unknown role (no such user, or a role outside the allow-set) is denied.
 * Fail-closed: anything not explicitly in {@link MODERATOR_ROLES} is false.
 */
export declare function isModeratorRole(role: string | null | undefined): boolean;
/** A moderator decision on a review item. `reject` is terminal (→ REJECTED). */
export type ModeratorDecision = "approve" | "reject";
/** The media "kind" derived from its stored mimeType (drives the client view). */
export type MediaKind = "image" | "video" | "audio" | "other";
/** Derive the coarse media kind from a mimeType. Total; unknown → "other". */
export declare function mediaKindOf(mimeType: string | null | undefined): MediaKind;
/** One per-track verdict surfaced to the moderator (video items carry ≥1). */
export interface TrackVerdictView {
    track: "VISUAL" | "AUDIO";
    /** The resolved classifier decision, or null while the job is in flight. */
    decision: string | null;
}
/** A single queue row as returned to the admin client. */
export interface ReviewQueueItem {
    id: string;
    tenantId: string;
    mimeType: string;
    kind: MediaKind;
    lifecycle: MediaLifecycle;
    size: number;
    width: number | null;
    height: number | null;
    /** Video duration in seconds (null for images). */
    duration: number | null;
    createdAt: string;
    /** Per-track moderation verdicts (visual / audio→transcript). */
    tracks: TrackVerdictView[];
}
export interface ReviewQueuePage {
    items: ReviewQueueItem[];
    hasMore: boolean;
    nextCursor?: string;
}
/**
 * Minimal structural Prisma surface this handler needs. Declared narrowly so a
 * test mock is trivial and the handler cannot reach for anything undeclared.
 */
export interface ReviewPrismaLike {
    mediaFile: {
        findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
        findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
        update: (args: unknown) => Promise<Record<string, unknown>>;
    };
    user: {
        findUnique: (args: unknown) => Promise<{
            role: string;
        } | null>;
    };
}
/**
 * Consuming app calls this at startup so a human approval actually promotes the
 * reviewed bytes. Re-exported from `@de-otio/trellis`.
 *
 * Without it, `decide()` still applies the lifecycle transition but copies
 * nothing to the serve prefix — and says so, loudly, on every approval.
 */
export declare function setMediaReviewPromotion(port: ReviewPromotionPort): void;
/** The injected promotion capability, or undefined. Read by the review route. */
export declare function getMediaReviewPromotion(): ReviewPromotionPort | undefined;
/** Test-only: clear the injected capability between cases. */
export declare function __resetMediaReviewPromotionForTests(): void;
/** Outcome discriminant for decide()/escalateCsam(), mapped to HTTP by the route. */
export type DecisionResult = {
    ok: true;
    status: MediaLifecycle;
    promoted: boolean;
} | {
    ok: false;
    code: "NOT_FOUND";
} | {
    ok: false;
    code: "ILLEGAL_STATE";
    from: MediaLifecycle;
};
/**
 * The coordinates a promotion needs, resolved through a port rather than read
 * off the row here.
 *
 * `stagingVersionId` is the pin captured when the classifier ran. Where a
 * consuming application keeps it is its own business (today, inside an existing
 * JSON column), which is exactly why this is a port: the handler must not know.
 */
export interface ReviewPromoteCoords {
    readonly tenantId: string;
    readonly uploadId: string;
    readonly contentHash: string;
    readonly stagingVersionId: string | null;
}
/**
 * The capability that lets a human approval actually make bytes servable.
 *
 * Without it, `decide()` can flip a row to APPROVED but nothing copies the
 * reviewed bytes to the serve prefix. With it, approval performs the SAME
 * version-pinned promotion the automatic path performs — the moderator's
 * approval applies to the bytes the moderator saw, and to nothing else.
 *
 * OPTIONAL on `decide()`, because this is a published package and a required
 * argument would break every existing caller. The consequence is stated rather
 * than hidden: when it is absent, `decide()` behaves as before and says so in a
 * log line, and no promotion happens.
 */
export interface ReviewPromotionPort {
    readonly storage: StoragePort;
    /** Resolve the promote coordinates for a media object, or null when unknown. */
    coordsFor(mediaId: string): Promise<ReviewPromoteCoords | null>;
    readonly log?: PromoteLog;
}
export declare class MediaReviewHandler {
    /**
     * Resolve the caller's server-side role from the User table and decide whether
     * they may access the moderator surface. Returns the role string when allowed,
     * or null when denied (no such user, or a non-moderator role). The route maps
     * null → 403. DB is the source of truth; the session only supplies the userId.
     */
    resolveModeratorRole(db: ReviewPrismaLike, userId: string): Promise<string | null>;
    /**
     * Paginated queue of media in REVIEW/QUARANTINED, newest first, cursor over
     * `id`. Each row carries its per-track moderation verdicts so the client can
     * show the visual/audio/transcript breakdown for video without a second call.
     */
    list(db: ReviewPrismaLike, opts?: {
        limit?: number;
        cursor?: string;
        kind?: MediaKind;
    }): Promise<ReviewQueuePage>;
    private toQueueItem;
    /**
     * Apply a human approve/reject to a review item. The transition is decided by
     * the pure `nextLifecycle` machine (`human` event); this shell only persists
     * the resulting lifecycle, performs the promotion the machine implies, and
     * writes the audit row.
     *
     * APPROVE IS A CLAIM ABOUT SPECIFIC BYTES. A moderator looked at one version
     * of an object and said yes to that version. So when the promotion port is
     * wired, approval copies the VERSION-PINNED bytes the classifier ran on — the
     * same routine the automatic path uses — and refuses outright when that
     * version can no longer be resolved. It never resolves "whatever is at the
     * staging key now": between the review and the click, that key may hold
     * something else entirely, and copying it would launder unreviewed bytes
     * through a human decision.
     *
     * FAIL-CLOSED throughout: a missing object, an unresolvable pin, or a failed
     * copy all leave the item in REVIEW rather than marking it servable.
     *
     * Returns a DecisionResult; the route maps it to HTTP. Audit is written for
     * every APPLIED decision (success), before returning.
     */
    decide(db: ReviewPrismaLike, auditLogger: TrellisAuditLogger, env: TrellisAuditLoggerEnv, input: {
        mediaId: string;
        decision: ModeratorDecision;
        moderatorUserId: string;
        region: Region;
        ipAddress?: string;
        userAgent?: string;
    }, promotion?: ReviewPromotionPort | undefined): Promise<DecisionResult>;
    /**
     * Copy the version-pinned reviewed bytes to the serve prefix.
     *
     * Returns true only when the serve object is genuinely there afterwards.
     * Every failure — unknown coordinates, an unresolvable pin, a copy that
     * throws — returns false, and the caller holds the item in REVIEW. Nothing
     * here is best-effort: this is the step that decides whether bytes become
     * publicly reachable.
     */
    private promoteReviewed;
    /**
     * CSAM escalation STUB. Drives the item to REJECTED via the pure `csam` event
     * (terminal from any state), LOCKS it (hidden=true so it is never served
     * anywhere), and writes a CRITICAL audit row flagged `pagedForHumanReview`.
     *
     * DELIBERATELY performs NO automated reporting: statutory CSAM handling
     * (NCMEC / national hotline, evidence preservation) is a HUMAN process. This
     * endpoint only locks the artifact and records the page; the runbook takes
     * over from the audit trail. See doc/.../media-moderation-ops.md CSAM runbook.
     */
    escalateCsam(db: ReviewPrismaLike, auditLogger: TrellisAuditLogger, env: TrellisAuditLoggerEnv, input: {
        mediaId: string;
        moderatorUserId: string;
        region: Region;
        ipAddress?: string;
        userAgent?: string;
    }): Promise<DecisionResult>;
    /**
     * Decide + audit a moderator VIEW (bypass) of an item's bytes. Returns the
     * servable `originalKey` when the item is bypass-eligible (REVIEW/QUARANTINED,
     * not deleted) AND writes the audit row BEFORE the route streams bytes — the
     * bypass is never silent. Returns null when the item is not bypass-eligible
     * (the route then denies uniformly). The role check is done by the route via
     * resolveModeratorRole; this method assumes an authorised moderator.
     */
    authorizeView(db: ReviewPrismaLike, auditLogger: TrellisAuditLogger, env: TrellisAuditLoggerEnv, input: {
        mediaId: string;
        moderatorUserId: string;
        region: Region;
        ipAddress?: string;
        userAgent?: string;
    }): Promise<{
        originalKey: string;
        mimeType: string;
    } | null>;
}

// ===== lib/media/moderation-deadline.d.ts =====
/**
 * moderation-deadline.ts — bound how long a moderation call may take, and make
 * the deadline bind the DECISION rather than merely the wait.
 *
 * A timeout that only stops waiting is not a timeout. Two halves are needed and
 * both are here:
 *
 *  1. **Abort the call.** The wrapper passes an `AbortSignal` down, so an
 *     adapter that honours it stops burning a connection and a provider quota
 *     on an answer nobody is listening for any more.
 *  2. **Commit the decision at the deadline.** When the clock runs out the
 *     wrapper throws — permanently, for that call. If the provider resolves
 *     `approved` a second later, that resolution is DISCARDED: the caller has
 *     already recorded a fail-closed verdict, and a late success that could
 *     overwrite it would mean the timeout was advisory. A late rejection is
 *     swallowed too, so it cannot surface as an unhandled rejection and take
 *     the worker down.
 *
 * The timeout thrown is `retryable: true`. A deadline says something about the
 * moment, not about the media: the same bytes may well classify fine on the
 * next delivery. Retrying is bounded by the existing delivery-attempt limit and
 * its dead-letter queue, so the fail-open-for-retry choice cannot loop forever,
 * and it keeps a provider outage visible as retries rather than silently
 * absorbed as a pile of review items.
 *
 * NO COMPILED-IN TIMEOUT. The value is operator config. A timeout baked into a
 * public tarball tells an adversary exactly how long a call must be stalled for
 * to force every upload into review — a cheap denial of moderation. Absence is
 * a wiring error, and this module refuses to construct rather than inventing
 * one.
 */
import { ModerationProviderError, type MediaModerationProvider } from "./moderation-provider.js";
/** Thrown at wiring time when no deadline was configured. */
export declare class ModerationDeadlineConfigError extends Error {
    constructor();
}
export interface ModerationDeadlineConfig {
    /** Milliseconds a single seam call may take. Operator-supplied; no default. */
    readonly timeoutMs?: number;
}
/** Timer seam, so tests drive the clock instead of waiting on it. */
export interface DeadlineTimers {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
}
/** The error a deadline breach throws. Typed, and retryable by contract. */
export declare function deadlineExceeded(operation: string): ModerationProviderError;
/**
 * Wrap a provider so every seam call is deadline-bounded.
 *
 * Throws {@link ModerationDeadlineConfigError} when no timeout was configured —
 * the "refuse to enable the feature" form of failing closed, chosen over a
 * per-call review because an unconfigured deadline is a deployment mistake that
 * should be visible at wiring time rather than as a slow drip of review items.
 */
export declare function withModerationDeadline(provider: MediaModerationProvider, config: ModerationDeadlineConfig, timers?: DeadlineTimers): MediaModerationProvider;

// ===== lib/media/moderation-metrics.d.ts =====
/**
 * moderation-metrics.ts — what operators may see about moderation, and what
 * nobody unauthenticated may see.
 *
 * Moderation counters are genuinely needed: a provider that has quietly started
 * reviewing everything, or a taxonomy running unpinned for a month, are both
 * invisible without them. But the same counters are an EVASION ORACLE if they
 * are readable and fresh. Upload a probe, poll a public counter, watch which
 * bucket moves: that is a per-upload verdict readout, and with it an adversary
 * tunes content against the classifier without ever seeing a decision.
 *
 * Three controls, and the reasons they are shaped the way they are:
 *
 *  1. **Aggregates only, never per-item.** Counters are keyed by
 *     `{provider, decision}` and carry no media id, tenant, user, or key.
 *  2. **Closed windows only.** {@link ModerationMetrics.snapshot} reports
 *     COMPLETED time buckets and never the one in progress. A probe uploaded
 *     now cannot be read back now, which is what breaks the poll-and-correlate
 *     loop rather than merely slowing it.
 *  3. **Authenticated surface only.** The public health payload carries exactly
 *     one moderation fact — {@link ModerationMetrics.publicHealth} — a boolean
 *     saying a real provider is wired. That is what an uptime check needs and
 *     it reveals nothing about any upload.
 *
 * The provider NAME is treated as untrusted input even though it comes from our
 * own adapter: it becomes a metric dimension, and a hostile or merely sloppy
 * value there means unbounded cardinality in a metrics backend. It must match
 * one the operator declared, and it is length- and charset-checked regardless.
 */
import type { ModerationDecision } from "./media-lifecycle.js";
/** The placeholder recorded when a provider name is not acceptable. */
export declare const UNKNOWN_PROVIDER_DIMENSION = "unknown";
/**
 * Is this string safe and expected as a metric dimension?
 *
 * Both halves matter: the charset/length check bounds cardinality damage, and
 * the declared-set check means a provider cannot introduce a new dimension
 * value at runtime just by renaming itself.
 */
export declare function isAcceptableProviderDimension(name: unknown, declaredProviders: ReadonlyArray<string>): name is string;
export interface ModerationMetricsConfig {
    /**
     * The provider names the operator declared. Anything else is recorded under
     * {@link UNKNOWN_PROVIDER_DIMENSION} rather than becoming a new dimension.
     */
    readonly declaredProviders: ReadonlyArray<string>;
    /**
     * Bucket width in milliseconds. Coarser means a smaller correlation window;
     * operator-supplied because how coarse is enough depends on upload volume.
     */
    readonly windowMs: number;
    /** Injected clock — no ambient `Date.now`, so tests can freeze it. */
    readonly now: () => number;
    /** Standing posture flag from the label policy: is the taxonomy unpinned? */
    readonly unpinnedTaxonomy?: boolean;
    /** Whether a real (non-fail-closed) provider is wired. */
    readonly providerActive?: boolean;
}
export declare class ModerationMetricsConfigError extends Error {
    constructor(message: string);
}
/** One closed window's counters. */
export interface ModerationWindow {
    /** Start of the bucket, in epoch milliseconds. */
    readonly windowStart: number;
    /** `${provider}:${decision}` → count. */
    readonly decisions: Readonly<Record<string, number>>;
    /** `${provider}` → count of infrastructure faults that failed a track closed. */
    readonly infraFaults: Readonly<Record<string, number>>;
}
export interface ModerationMetricsSnapshot {
    /** COMPLETED windows only — never the one currently accumulating. */
    readonly windows: ReadonlyArray<ModerationWindow>;
    /**
     * True while the label policy runs without a taxonomy pin. A standing
     * condition, surfaced continuously rather than as a boot-time log line
     * nobody re-reads.
     */
    readonly unpinnedTaxonomy: boolean;
}
/** Everything the UNAUTHENTICATED health payload may say about moderation. */
export interface ModerationPublicHealth {
    readonly moderationProviderActive: boolean;
}
export declare class ModerationMetrics {
    private readonly config;
    private readonly buckets;
    constructor(config: ModerationMetricsConfig);
    /** Record one classifier decision. Never throws; observability is not a gate. */
    recordDecision(provider: unknown, decision: ModerationDecision): void;
    /**
     * Record an infrastructure fault that failed a track closed.
     *
     * This counter exists because fail-closed is otherwise INDISTINGUISHABLE from
     * healthy caution: a provider that is down and a provider that is being
     * careful both produce review items. Without this, an outage looks like a
     * busy week.
     */
    recordInfraFault(provider: unknown): void;
    /**
     * Closed windows, newest last. The in-progress window is deliberately
     * withheld — that omission is the anti-oracle control, not a rounding detail.
     */
    snapshot(): ModerationMetricsSnapshot;
    /** The only moderation fact the public health endpoint may carry. */
    publicHealth(): ModerationPublicHealth;
    private dimensionFor;
    private currentWindowStart;
    private bucket;
    private evictOldWindows;
}

// ===== lib/media/moderation-provider.d.ts =====
import type { ModerationDecision } from "./media-lifecycle.js";
export type { ModerationDecision };
/**
 * How a stored object is pinned to the EXACT bytes a moderation job scanned.
 *
 * Stores differ in what they can offer: object versioning (`versionId`), an
 * entity tag (`etag`), or a caller-computed digest (`contentHash`). The union
 * lets an adapter carry whichever its store supports without core knowing which.
 *
 * OPAQUE CAPTURE-AND-COMPARE. A pin is captured once, at job start, and later
 * compared for equality against the value recorded then — it is NEVER
 * recomputed from bytes and never interpreted. In particular an `etag` is not a
 * content digest on every store (a multipart upload's ETag is a digest of
 * digests plus a part count), so treating one as a hash would silently compare
 * unequal for identical bytes. Equality is `kind` AND `value`; a differing or
 * absent pin is drift, and drift fails closed.
 */
export interface MediaPin {
    readonly kind: "versionId" | "etag" | "contentHash";
    readonly value: string;
}
/** An opaque reference to an already-stored image object (key + bucket handle). */
export interface ImageRef {
    readonly bucket: string;
    readonly key: string;
    /**
     * Pin the reference to the EXACT stored bytes (AR-SEC F3), so a later
     * overwrite of the same key can never change what a started job scanned.
     */
    readonly pin?: MediaPin;
}
/** An opaque reference to an already-stored object in S3-compatible storage. */
export interface S3Ref {
    readonly bucket: string;
    readonly key: string;
    /**
     * Pin the reference to the EXACT stored bytes (AR-SEC F3), so a later
     * overwrite of the same key can never change what a started job scanned.
     */
    readonly pin?: MediaPin;
    /**
     * @deprecated Alias for `pin: { kind: "versionId", value }`. Kept so existing
     * consumers keep compiling and their refs keep pinning; new code sets `pin`.
     * When both are present `pin` wins.
     */
    readonly versionId?: string;
}
/**
 * The pin a ref carries, normalised across the `pin` field and the deprecated
 * `versionId` alias. Returns `null` when the ref is unpinned — which callers
 * must treat as "cannot certify these bytes", never as "any bytes will do".
 */
export declare function refPin(ref: ImageRef | S3Ref): MediaPin | null;
/**
 * Opaque pin equality. Two pins match iff both are present, of the same kind,
 * and byte-identical. A missing pin on either side is NOT a match — absence of
 * evidence is not evidence of sameness.
 */
export declare function pinsEqual(a: MediaPin | null, b: MediaPin | null): boolean;
/** A single classifier label. `category` is an OPAQUE token, never a real-category string. */
export interface ModerationLabel {
    readonly category: string;
    readonly confidence: number;
}
/**
 * ModerationVerdict — the RESULT object (hub name). The `decision` is the
 * 3-value classifier verdict; `labels` are opaque category tokens with
 * confidences; `provider` identifies which backend produced it.
 */
export interface ModerationVerdict {
    readonly decision: ModerationDecision;
    readonly labels: ReadonlyArray<ModerationLabel>;
    readonly provider: string;
    /**
     * The classifier/taxonomy build that produced this verdict, as an OPAQUE
     * string the provider chooses (a model id, a taxonomy version, a build tag).
     * Core never parses it — it only compares it for equality against the version
     * the operator pinned, so a silent taxonomy change cannot keep approving
     * against a category map that no longer means what it did.
     *
     * OPTIONAL, because this is a published seam and a required field would break
     * every existing adapter. The consequence is stated rather than hidden: under
     * a pin mode that demands a version, ABSENCE is unverifiable and therefore
     * `review` — a provider that reports nothing gets no approvals.
     */
    readonly modelVersion?: string;
}
/**
 * Per-call options every seam method accepts.
 *
 * `signal` lets the caller abort in-flight provider work when its deadline
 * expires. Aborting is only half the contract: the DECISION is committed at the
 * deadline, so a provider that resolves afterwards must not be able to overturn
 * the fail-closed verdict already recorded. The deadline wrapper enforces both
 * halves; an adapter only needs to honour the signal.
 */
export interface ModerationCallOptions {
    readonly signal?: AbortSignal;
}
/**
 * The handle returned when a video moderation job is started.
 *
 * `jobId` is the poll handle. `initialDecision` is present only when the
 * backend ALREADY resolved the whole track during the start call — which is
 * what core's frame-sampling adapter does: it samples, classifies and
 * aggregates inline, so there is no remote job to poll and no completion
 * notification will ever arrive for this id. The caller persists that decision
 * immediately instead of waiting for a message that is not coming.
 *
 * Both extra fields are OPTIONAL, so an existing adapter that returns `{ jobId }`
 * still satisfies the seam.
 */
export interface VideoModerationStart {
    readonly jobId: string;
    /** Set when the track resolved during `start`; no poll or completion follows. */
    readonly initialDecision?: ModerationDecision;
    /** The taxonomy version the job started under, for drift detection at completion. */
    readonly modelVersion?: string;
    /**
     * Which sampling/scoring policy produced this result. Together with the
     * content hash, the provider, and {@link modelVersion} it identifies the
     * inputs a verdict depended on — the four things you need to answer "how do
     * you know you caught it?" months later, and none of them can be
     * reconstructed after the fact.
     */
    readonly policyVersion?: string;
    /** The raw labels behind the collapsed decision. SERVER-SIDE ONLY (see below). */
    readonly labels?: ReadonlyArray<ModerationLabel>;
    /** The per-frame audit record. SERVER-SIDE ONLY (see below). */
    readonly detail?: ModerationJobDetail;
}
/**
 * The evidence behind a video verdict, for the audit trail.
 *
 * NEVER SEND ANY OF THIS TO A CLIENT. Confidences, frame timings, sampling
 * parameters, and skip counts are a tuning oracle: with them an adversary
 * learns which frames were looked at and how close a piece of content came to
 * a bar, which is precisely enough to iterate against the classifier. It exists
 * so operators can audit their own pipeline, and it stops at the server.
 */
export interface ModerationJobDetail {
    /** How many frames the plan expected, given the clip and the policy. */
    readonly expectedFrames?: number;
    /** How many frames were actually classified. */
    readonly framesScored?: number;
    /**
     * How many expected frames never produced a verdict — undecodable, or lost
     * to an error. A rising number here means the pipeline is seeing less of
     * each video than its policy claims.
     */
    readonly framesSkipped?: number;
    /** Per-frame evidence, in temporal order. */
    readonly frames?: ReadonlyArray<ModerationFrameDetail>;
}
/**
 * Per-frame evidence for one sampled still. Server-side only.
 *
 * **This shape is expected to grow a per-frame perceptual hash, and when it
 * does the hash MUST be computed during the scoring pass.** The frame-sampling
 * adapter deletes every frame it extracted in a `finally` — see the cleanup in
 * `frame-sampling-adapter.ts` — so a hash added later cannot be backfilled from
 * stored data: the only way to recompute it is to re-extract from the original
 * video and re-sample, which is the expensive work a frame hash exists to
 * avoid. Capture it here at scoring time, or lose it for all media already
 * processed.
 *
 * That ordering is the whole constraint. Adding the field is easy; adding it in
 * the wrong place yields a column that is correct going forward and empty for
 * everything historical, which looks like a working cache with a zero hit rate.
 */
export interface ModerationFrameDetail {
    /** Position in the sampled sequence. */
    readonly index: number;
    /** Offset into the clip, in seconds, at the policy's sampling rate. */
    readonly offsetSeconds: number;
    /** `null` when the frame could not be classified. */
    readonly decision: ModerationDecision | null;
    readonly labels?: ReadonlyArray<ModerationLabel>;
    readonly modelVersion?: string;
}
/**
 * The one canonical moderation seam. Image moderation is sync-ish (resolves a
 * verdict directly); video moderation is async (start → poll), mirroring the
 * cloud provider's job model. Audio reuses the text-moderation path and adds no
 * method here.
 *
 * A provider that can only classify STILL IMAGES satisfies this seam: core's
 * frame-sampling video adapter turns `moderateImage` into video moderation by
 * sampling frames and aggregating their verdicts. Implementing
 * `startVideoModeration`/`getVideoModeration` natively is for backends that
 * have their own video job model.
 */
export interface MediaModerationProvider {
    /**
     * What this provider calls itself — the same token it puts in
     * `ModerationVerdict.provider`.
     *
     * Optional, because adding a required member to a published seam would break
     * every adapter already implementing it. But absence costs something real:
     * `ModerationVerdict.provider` only exists once a call has SUCCEEDED, so on
     * the paths where there is no verdict — a throw, a deadline breach, or a
     * cache lookup that happens *before* the call — core has no way to attribute
     * the work except by asking the provider. A provider that reports no name is
     * attributed to {@link UNKNOWN_PROVIDER_NAME} on those paths.
     *
     * Keep it identical to the token you put in `verdict.provider`, so the
     * pre-call and post-hoc attributions agree. The one principled exception is a
     * core adapter that AGGREGATES other providers' work: its refusal verdicts
     * are its own (no classifier ran) while its scored verdicts are attributed to
     * the classifier underneath. `FrameSamplingVideoModerationAdapter` does
     * exactly that, and documents it at `scoredAttribution`.
     *
     * Read it through {@link moderationProviderName} rather than directly, and
     * see the wrapper rule documented there.
     */
    readonly name?: string;
    /** Synchronous-style image moderation: resolves a verdict directly. */
    moderateImage(input: ImageRef, options?: ModerationCallOptions): Promise<ModerationVerdict>;
    /** Kicks off async video moderation; returns a handle to poll. */
    startVideoModeration(input: S3Ref, options?: ModerationCallOptions): Promise<VideoModerationStart>;
    /** Polls a previously-started video moderation job for its verdict. */
    getVideoModeration(jobId: string, options?: ModerationCallOptions): Promise<ModerationVerdict>;
}
/** Attribution for a provider that reports no name of its own. */
export declare const UNKNOWN_PROVIDER_NAME = "unknown";
/**
 * The provider's self-reported name, or {@link UNKNOWN_PROVIDER_NAME}.
 *
 * Core calls this instead of reading `.name` so that one rule holds everywhere:
 * a name is a non-empty string or it does not count. A provider that reports
 * `""`, whitespace, or a non-string is attributed as unknown rather than
 * producing an empty dimension — an empty string is the value a partly-wired
 * adapter yields, and it must not read as a distinct identity.
 *
 * **The wrapper rule.** A decorator around a provider (a deadline, a
 * frame-sampling adapter, a retry shim) must PASS THE INNER NAME THROUGH, never
 * substitute its own. The name answers "whose classifier produced this?", and
 * wrapping does not change the answer. Substituting would split one provider's
 * counters and cache entries across two identities the moment an operator adds
 * a wrapper — and the split would look like a traffic shift rather than a
 * config change.
 *
 * This deliberately does NOT validate the charset. Metric dimensions have their
 * own stricter admission rule against the operator's declared set (see
 * `isAcceptableProviderDimension`); a name that is honest but undeclared should
 * still be usable for a cache key and a log line.
 */
export declare function moderationProviderName(provider: Pick<MediaModerationProvider, "name"> | null | undefined): string;
/**
 * The typed error a provider adapter throws so core can classify the failure
 * without pattern-matching on vendor error names.
 *
 * `retryable` is the adapter's own judgement about whether the SAME call could
 * succeed later:
 *   - `true`  — transient (throttle, 5xx, socket). Core retries; the existing
 *               3-strike/DLQ path remains the upper bound.
 *   - `false` — permanent for these bytes (rejected input, unsupported media).
 *               Core stops retrying and fails the track closed to `review`.
 *
 * A typed error whose cause the adapter cannot attribute is thrown with
 * `retryable: false` AND `unknownCause: true`: core then fails closed to
 * `review` *and* emits an infra-fault signal, because a fail-closed verdict
 * that silently absorbs an infrastructure outage is indistinguishable from
 * healthy caution — exactly the blindness that lets an outage run for days.
 */
export declare class ModerationProviderError extends Error {
    readonly retryable: boolean;
    /** The adapter could not attribute the cause — core alerts as well as fails closed. */
    readonly unknownCause: boolean;
    constructor(message: string, options?: {
        retryable: boolean;
        unknownCause?: boolean;
        cause?: unknown;
    });
}
/**
 * Structural type guard for {@link ModerationProviderError}. Structural rather
 * than `instanceof` on purpose: an adapter bundled with its own copy of this
 * package (npm nesting, a linked workspace) produces an error whose prototype
 * chain is a DIFFERENT class object, and an `instanceof` check would silently
 * demote it to the untyped fallback.
 */
export declare function isModerationProviderError(err: unknown): err is ModerationProviderError;
export type WarnSink = (message: string, data?: unknown) => void;
/**
 * A verdict that fails closed: every call resolves to `review` with no labels.
 * Nothing this provider returns can ever auto-approve media. Used as the safe
 * default before a concrete provider is injected (dev only — see the startup
 * guard below).
 */
export declare class NullModerationProvider implements MediaModerationProvider {
    readonly name = "null";
    private readonly warn;
    constructor(warn?: WarnSink);
    private failClosed;
    moderateImage(_input: ImageRef, _options?: ModerationCallOptions): Promise<ModerationVerdict>;
    startVideoModeration(_input: S3Ref, _options?: ModerationCallOptions): Promise<VideoModerationStart>;
    getVideoModeration(_jobId: string, _options?: ModerationCallOptions): Promise<ModerationVerdict>;
}
/**
 * Returns true for the fail-closed Null provider. The startup guard uses this to
 * reject Null outside dev.
 */
export declare function isNullModerationProvider(provider: MediaModerationProvider): boolean;
/**
 * A test seam: returns canned verdicts on demand. Default is the fail-closed
 * `review`. Labels use ONLY abstract category tokens (`category_a`,
 * `category_b`); no real-category strings, no real imagery ever.
 */
export declare class MockModerationProvider implements MediaModerationProvider {
    readonly name = "mock";
    private imageVerdict;
    private videoVerdict;
    private imageResponder?;
    private jobIdSeq;
    /** Every `moderateImage` ref, in call order — for asserting frame fan-out. */
    readonly imageCalls: ImageRef[];
    /** Every `startVideoModeration` ref, in call order. */
    readonly startVideoCalls: S3Ref[];
    constructor(canned?: {
        image?: ModerationVerdict;
        video?: ModerationVerdict;
    });
    /**
     * Program the verdict returned by `moderateImage`. Set `modelVersion` here to
     * exercise the taxonomy-pin modes; leave it unset to exercise the
     * unverifiable-pin path (which must fail closed to `review`).
     */
    setImageVerdict(verdict: ModerationVerdict): void;
    /**
     * Program a per-call responder for `moderateImage` — the seam for tests that
     * need a verdict to depend on WHICH ref was asked about (per-frame verdicts),
     * or that need the call to reject or to never settle. The responder owns its
     * own timing, so the mock stays free of clocks.
     */
    setImageResponder(responder: (input: ImageRef, options?: ModerationCallOptions) => Promise<ModerationVerdict>): void;
    /** Program the verdict returned by `getVideoModeration`. */
    setVideoVerdict(verdict: ModerationVerdict): void;
    moderateImage(input: ImageRef, options?: ModerationCallOptions): Promise<ModerationVerdict>;
    startVideoModeration(input: S3Ref, _options?: ModerationCallOptions): Promise<VideoModerationStart>;
    getVideoModeration(_jobId: string, _options?: ModerationCallOptions): Promise<ModerationVerdict>;
}
/** Abstract category tokens for Mock verdicts — never real-category strings. */
export declare const MOCK_CATEGORY_A = "category_a";
export declare const MOCK_CATEGORY_B = "category_b";
/**
 * Error raised by the startup guard when the fail-closed Null provider would run
 * outside dev. Carrying a distinct type lets the wiring fail loudly and lets
 * tests assert on it.
 */
export declare class NullProviderInProductionError extends Error {
    constructor(environment: string);
}
/**
 * Startup guard for the seam wiring. Validates that a non-Null provider is
 * injected whenever `environment !== "dev"`, and throws loudly otherwise.
 * Returns the provider unchanged when the check passes, so it can wrap the
 * injection site directly:
 *
 *   const provider = assertModerationProviderAllowed(injected, env.ENVIRONMENT);
 *
 * Fail loud, never silently run Null in prod.
 */
export declare function assertModerationProviderAllowed(provider: MediaModerationProvider, environment: string): MediaModerationProvider;

// ===== lib/media/promote-staging.d.ts =====
/**
 * promote-staging.ts — the version-pinned staging→CAS promotion, extracted so
 * every path that can make bytes servable goes through ONE implementation.
 *
 * There are two such paths: the automatic one (both moderation tracks approve)
 * and the human one (a moderator approves a REVIEW item). They must agree, and
 * before this module existed only the automatic one was pinned. That asymmetry
 * is the whole reason this is a module rather than a private helper:
 *
 *   A pin is captured when moderation STARTS, on the exact bytes that were
 *   scanned. Promotion copies THAT version. It never resolves "the current
 *   bytes at the staging key", because between the scan and the approval the
 *   object at that key may not be the object that was scanned — and an approval
 *   that copies whatever is there now is an approval of bytes nobody looked at.
 *
 * FAIL-CLOSED: when the pinned version cannot be resolved and no previously
 * promoted CAS object exists, this module reports `none` and the caller must
 * refuse to promote. Doubt holds in review; doubt never serves.
 */
import type { StoragePort } from "./media-ports.js";
/**
 * Where the servable bytes may legitimately come from.
 *
 * - `staging` — the pinned version the classifier actually scanned.
 * - `cas`     — an object already at the CAS key from a PRIOR pinned promote;
 *               those bytes were themselves pin-copied, so their provenance is
 *               intact and re-copying from staging would only risk adopting
 *               post-moderation bytes.
 * - `none`    — nothing certifiable. Callers must not promote.
 */
export type PromoteSource = {
    readonly kind: "staging";
    readonly versionId: string;
} | {
    readonly kind: "cas";
} | {
    readonly kind: "none";
};
/** Minimal logging seam; every call site already has one of this shape. */
export interface PromoteLog {
    info?: (msg: string, data?: unknown) => void;
    warn?: (msg: string, data?: unknown) => void;
    error?: (msg: string, data?: unknown) => void;
}
/**
 * Resolve which source, if any, may serve these bytes.
 *
 * Order matters: the pinned staging version is preferred (it is the freshest
 * certified copy), then an existing CAS object. A null/empty pin is NOT
 * degraded into an unpinned head of the staging key — that degradation is
 * exactly the TOCTOU this module exists to prevent — so an unpinned row can
 * only ever be satisfied by an already-promoted CAS object.
 */
export declare function resolvePromoteSource(args: {
    readonly storage: StoragePort;
    readonly stagingKey: string;
    readonly casKey: string;
    readonly stagingVersionId: string | null | undefined;
}): Promise<PromoteSource>;
/**
 * Copy the certified bytes to the CAS key and clean up the transient copies.
 *
 * - `staging` source ⇒ a version-pinned copy.
 * - `cas` source ⇒ no copy at all; the object is already there and re-copying
 *   from staging could adopt bytes that arrived after moderation.
 * - `none` ⇒ this function must not have been called; it throws rather than
 *   quietly doing nothing, because a silent no-op here reads at the call site
 *   as a successful promotion.
 *
 * Cleanup of the raw original and the staging copy is BEST-EFFORT: the CAS copy
 * is what serves, so a leftover transient object is storage noise rather than a
 * safety hole, and letting a delete failure fail the promotion would strand an
 * approved object un-servable.
 */
export declare function promotePinned(args: {
    readonly storage: StoragePort;
    readonly source: PromoteSource;
    readonly stagingKey: string;
    readonly casKey: string;
    /** Transient keys to remove after the copy (raw original, staging, poster). */
    readonly cleanupKeys: ReadonlyArray<string>;
    readonly log?: PromoteLog;
    /** Correlation data for the tolerated-delete log lines. */
    readonly logContext?: Record<string, unknown>;
}): Promise<void>;

// ===== lib/media/request-moderation.d.ts =====
import { type MediaModerationProvider, type ModerationVerdict } from "./moderation-provider.js";
import type { LabelPolicy, LabelPolicyContext } from "./label-policy.js";
import type { ModerationDecision } from "./media-lifecycle.js";
/**
 * Consuming app (Skybber) calls this at startup with its concrete moderation
 * provider (e.g. an AWS Rekognition adapter). MUST run before the upload route
 * serves. Re-exported from `@de-otio/trellis` (apps/api/src/index.ts).
 */
export declare function setMediaModerationProvider(provider: MediaModerationProvider): void;
/**
 * Returns the injected provider if one was registered, else a fail-closed
 * {@link NullModerationProvider} (every verdict = `review`). The upload handler
 * calls this on each sync-image request. Defaulting to Null — rather than
 * throwing — means an un-wired deploy degrades to REVIEW (never serves, never
 * 500), which is the safe behaviour for a moderation seam.
 */
export declare function getMediaModerationProvider(): MediaModerationProvider;
/** Test-only: clear the injected provider so tests don't leak across cases. */
export declare function __resetMediaModerationProviderForTests(): void;
/**
 * Consuming app calls this at startup to make the operator's label policy
 * authoritative over the provider's own decision. Re-exported from
 * `@de-otio/trellis`.
 */
export declare function setMediaLabelPolicy(policy: LabelPolicy): void;
/** The operator's label policy, or undefined when the provider's decision stands. */
export declare function getMediaLabelPolicy(): LabelPolicy | undefined;
/**
 * Apply the operator's policy to a verdict, or pass the provider's own decision
 * through when no policy is configured. Total: a policy that somehow throws is
 * treated as doubt, and doubt reviews.
 */
export declare function interpretVerdict(verdict: ModerationVerdict, context?: LabelPolicyContext): ModerationDecision;

// ===== lib/media/request-text-moderation.d.ts =====
import { type TextModerationProvider } from "./text-moderation.js";
/**
 * Consuming app (Skybber) calls this at startup with its concrete text
 * moderation provider (e.g. the hosted moderation-API adapter). MUST run before
 * the post/comment routes serve. Re-exported from `@de-otio/trellis`
 * (apps/api/src/index.ts).
 */
export declare function setTextModerationProvider(provider: TextModerationProvider): void;
/**
 * Returns the injected provider if one was registered, else a fail-closed
 * {@link NullTextModerationProvider} (every verdict = `review`). Defaulting to
 * Null — rather than throwing — means an un-wired deploy degrades to REVIEW
 * (text held, never auto-approved), which is the safe behaviour for a
 * moderation seam.
 */
export declare function getTextModerationProvider(): TextModerationProvider;
/** Test-only: clear the injected provider so tests don't leak across cases. */
export declare function __resetTextModerationProviderForTests(): void;

// ===== lib/media/text-moderation.d.ts =====
import type { ModerationVerdict } from "./moderation-provider.js";
import type { WarnSink } from "./moderation-provider.js";
/**
 * The text-moderation capability seam used by the AUDIO track (over a
 * transcript), by the POST/COMMENT text gate (see ../text-moderation-gate.ts),
 * and by any caller needing to classify free text into the canonical 3-value
 * verdict.
 *
 * Binding rule (same as MediaModerationProvider): absence of signal, an
 * internal fault, a spent budget, or ANY uncertainty MUST fail closed to
 * `decision: "review"`. An implementation must NEVER manufacture `approved`
 * from doubt.
 */
export interface TextModerationProvider {
    moderateText(text: string): Promise<ModerationVerdict>;
}
/**
 * A verdict that fails closed: every call resolves to `review` with no labels.
 * Nothing this provider returns can ever auto-approve text. Used as the safe
 * default before a concrete provider is injected (mirrors the image seam's
 * NullModerationProvider).
 */
export declare class NullTextModerationProvider implements TextModerationProvider {
    private readonly warn;
    constructor(warn?: WarnSink);
    moderateText(_text: string): Promise<ModerationVerdict>;
}
/** Returns true for the fail-closed Null text provider. */
export declare function isNullTextModerationProvider(provider: TextModerationProvider): boolean;
/**
 * Test seam: returns a canned verdict (default fail-closed `review`). Labels, if
 * programmed, must use ONLY opaque category tokens — never real-category strings.
 */
export declare class MockTextModerationProvider implements TextModerationProvider {
    private verdict;
    /** Records of each input, for assertions. */
    readonly calls: string[];
    constructor(canned?: ModerationVerdict);
    /** Program the verdict returned by subsequent `moderateText` calls. */
    setVerdict(verdict: ModerationVerdict): void;
    moderateText(text: string): Promise<ModerationVerdict>;
}

// ===== lib/media/track-verdict.d.ts =====
import type { ModerationDecision } from "./media-lifecycle.js";
/** The two moderation tracks a media object can carry. */
export type Track = "VISUAL" | "AUDIO";
/**
 * The outcome of moderating a single track.
 *
 * - `decided`  — the track was moderated and produced a 3-value decision.
 * - `errored`  — the track was expected but moderation faulted (no usable
 *                verdict). Fail-closed: treated as "must not approve".
 * - `absent`   — the track does not apply to this object (e.g. no audio track
 *                on a silent video, or no visual track on an audio-only object).
 *                Absence alone is NOT approval: combining with a present-and-
 *                approved track still degrades to "review", because we cannot
 *                certify a track we never inspected. The shell decides, per
 *                media kind, whether a single-track object should even call
 *                this combinator — see the obligations below.
 */
export type TrackOutcome = {
    readonly state: "decided";
    readonly decision: ModerationDecision;
} | {
    readonly state: "errored";
} | {
    readonly state: "absent";
};
/**
 * Combine two per-track outcomes into the object-level {@link ModerationDecision}.
 *
 * Precedence (checked in this order; total):
 *  1. If EITHER track is decided-"quarantine" => "quarantine". A confirmed
 *     flag on any track wins over everything: it is strictly more restrictive
 *     than "review", and a quarantine that decayed to "review" because the
 *     other track was absent/errored would be a safety regression.
 *  2. Else, "approved" IFF BOTH tracks are state "decided" AND BOTH decisions
 *     are "approved".
 *  3. Else (any "review", any "errored", any "absent", or any mix) => "review".
 *
 * Consequences (property-tested):
 *  - One missing/failed track NEVER yields "approved".
 *  - "approved" requires positive evidence on BOTH tracks.
 *  - "quarantine" is sticky across an absent/errored sibling track.
 *  - The function never returns "approved" from doubt.
 */
export declare function combineTrackVerdicts(visual: TrackOutcome, audio: TrackOutcome): ModerationDecision;

// ===== lib/mfa/totp-service.d.ts =====
/**
 * TOTP Service (AUTH-1)
 *
 * Implements RFC 6238 TOTP generation and verification using Web Crypto API.
 * No external dependencies — uses only the Web Crypto API available in
 * Cloudflare Workers and modern runtimes.
 */
/**
 * Generate a random TOTP secret (base32-encoded).
 */
export declare function generateSecret(): string;
/**
 * Generate a TOTP code for a given secret and time.
 */
export declare function generateTOTP(secret: string, time?: number): Promise<string>;
/**
 * Verify a TOTP code against a secret.
 * Allows a window of ±1 period to account for clock skew.
 */
export declare function verifyTOTP(secret: string, code: string, window?: number): Promise<boolean>;
/**
 * Build an otpauth:// URI for QR code generation.
 */
export declare function buildOTPAuthURI(secret: string, email: string, issuer?: string): string;
/**
 * Generate backup codes (10 codes, 8 alphanumeric chars each).
 */
export declare function generateBackupCodes(count?: number): string[];
/**
 * Hash a backup code for storage using SHA-256.
 */
export declare function hashBackupCode(code: string): Promise<string>;
/**
 * Encrypt a TOTP secret for database storage using AES-GCM.
 */
export declare function encryptSecret(secret: string, encryptionKey: string): Promise<string>;
/**
 * Decrypt a TOTP secret from database storage.
 */
export declare function decryptSecret(encryptedSecret: string, encryptionKey: string): Promise<string>;

// ===== lib/org-category/directory-profile-config.d.ts =====
/**
 * Directory-profile runtime configuration resolver.
 *
 * Shaped like `resolveMediaEnv()` in `env.ts` — reads `NEIGHBORHOOD_*` env
 * vars and returns a typed config object. Wiring this output into the `Env`
 * interface and `buildEnv()` is a Phase 3 integration step; handlers receive
 * the config as a constructor argument so tests can inject arbitrary values
 * without touching `process.env`.
 *
 * Threshold-secrecy convention: the specific numeric default for the
 * NEIGHBORHOOD fuzz radius is NOT documented in a comment here or at any
 * call site — the npm tarball is public and a hardcoded published constant
 * would defeat the fuzz. The default is a safe non-zero value that guarantees
 * NEIGHBORHOOD-precision listings never silently serve exact coordinates when
 * the env var is absent.
 */
export interface DirectoryProfileConfig {
    /**
     * The radius in metres within which a NEIGHBORHOOD-precision tenant's true
     * coordinates are randomly displaced before storage in `displayLat` /
     * `displayLng`. Must be > 0; if the env var is unset or invalid, a safe
     * non-zero fallback is used (never zero, which would mean exact coordinates).
     */
    neighborhoodFuzzMeters: number;
}
/**
 * Build the directory-profile config from `process.env`.
 *
 * NEIGHBORHOOD_FUZZ_RADIUS_METERS — fuzz radius in metres for NEIGHBORHOOD
 * precision coordinate storage. Defaults to a safe non-zero value if unset,
 * zero, negative, or non-numeric.
 */
export declare function resolveDirectoryProfileConfig(): DirectoryProfileConfig;

// ===== lib/org-category/directory-search-config.d.ts =====
/**
 * Directory-search runtime configuration (standalone resolver module).
 *
 * Shaped like `resolveMediaEnv()` in `env.ts`: reads every operational
 * threshold from `process.env` with a conservative safe default, so that no
 * abuse-limit constant is compiled into the published npm tarball (CLAUDE.md
 * rule 8 — threshold-secrecy: "the npm tarball is public, so a hard-coded
 * threshold is a published threshold"). Handlers/executors receive a resolved
 * `DirectorySearchConfig` and never read `process.env` themselves.
 *
 * Wiring this resolver's output into the `Env` interface / `buildEnv()` in
 * `env.ts` is a Phase 3 integration step (see the plan's "Grounding" note on
 * `env.ts` being a shared-file barrier). Until then `getDirectorySearchConfig()`
 * reads `env.directorySearch` if present and otherwise falls back to resolving
 * directly, so this task does not have to edit `env.ts`.
 *
 * The concrete pagination minimums (max page size, max page depth) are fixed by
 * the implementation plan and are safe *minimums* — tunable strictly upward via
 * the env vars below, never a bare literal in the query code. A broad filter
 * (e.g. category=business) combined with a large page size is a near-complete
 * directory scrape even under rate limiting, so these bounds are the load-bearing
 * anti-enumeration guard (security review S18), not cosmetic.
 */
/** Resolved directory-search configuration consumed by the search executor + route. */
export interface DirectorySearchConfig {
    /**
     * Minimum trigram query length enforced at the API boundary before a name
     * query reaches Postgres (S10). `pg_trgm` similarity is meaningless below
     * trigram length and short queries generate disproportionately large GIN
     * candidate sets.
     */
    minQueryLength: number;
    /** Maximum results returned per page ("tens, not hundreds" — S18). */
    maxPageSize: number;
    /**
     * Maximum reachable page index count (a hard ceiling on cumulative
     * extraction). Valid page indices are `0 .. maxPageDepth - 1`.
     */
    maxPageDepth: number;
    /**
     * Upper bound (metres) on a location-radius query window. A caller may request
     * a smaller radius; anything above this (or an omitted radius) is clamped to
     * it, so no request can trigger an unbounded-radius scan.
     */
    maxRadiusMeters: number;
    /**
     * Postgres `statement_timeout` (ms) applied to the search query as a
     * defense-in-depth backstop against an expensive plan surviving the
     * query-shape limits (S10/S18). Runtime config, never hardcoded at the
     * call site.
     */
    statementTimeoutMs: number;
    /** Per-user rate-limit ceiling (requests) over `rateLimitWindowSeconds`. */
    rateLimit: number;
    /** Rate-limit window in seconds. */
    rateLimitWindowSeconds: number;
}
/**
 * Resolve directory-search config from `process.env`. Mirrors
 * `resolveMediaEnv()`'s `{ <namespace>: {...} }` return shape so Phase 3 can
 * spread it straight into `buildEnv()`.
 *
 * Defaults are the plan-mandated safe minimums (max page size, max page depth)
 * plus conservative dev-safe values for the timeout/rate-limit backstops; the
 * operative production values are injected per-environment via the env vars,
 * so no operational ceiling is baked into `dist/`.
 */
export declare function resolveDirectorySearchEnv(): {
    directorySearch: DirectorySearchConfig;
};
/**
 * Read the directory-search config, preferring an already-wired
 * `env.directorySearch` (Phase 3) and otherwise resolving directly. Lets the
 * route/executor stay agnostic to whether `env.ts` wiring has landed yet.
 */
export declare function getDirectorySearchConfig(env: unknown): DirectorySearchConfig;

// ===== lib/provenance/posture.d.ts =====
/**
 * How a tenant treats the author's provenance declaration.
 *
 * Mirrors the Prisma `TenantDisclosurePosture` enum. A tenant row's column is
 * NULLABLE: null means "no override, use the platform default from env".
 */
export type DisclosurePosture = "OPTIONAL" | "REQUIRED_FOR_AI" | "PROMPTED";
export declare const DISCLOSURE_POSTURES: readonly DisclosurePosture[];
/**
 * The platform default when neither the tenant column nor env supplies one.
 *
 * `PROMPTED` because it is the honest middle: the compose flow asks, and "prefer
 * not to say" is a valid answer that resolves to `UNKNOWN`. Defaulting to
 * `REQUIRED_FOR_AI` would impose a professional-deployer duty on consumers who do
 * not have one; defaulting to `OPTIONAL` would silently drop the prompt for the
 * B2B tenants who do.
 *
 * NOT a secret threshold — this is published policy, not a detection parameter, so
 * a compiled fallback is appropriate here (contrast CLAUDE.md rule 8, which covers
 * rate limits, detection thresholds, sampling rates and retention windows).
 */
export declare const DEFAULT_DISCLOSURE_POSTURE: DisclosurePosture;
/** Narrow an untrusted string (env var, JSON body) to a posture, or null. */
export declare function parseDisclosurePosture(raw: string | null | undefined): DisclosurePosture | null;
/** The per-tenant override column, shaped so a partial select still typechecks. */
export interface TenantPostureOverride {
    readonly disclosurePosture?: DisclosurePosture | null;
}
/**
 * Resolve the EFFECTIVE posture for a tenant:
 *
 *   effective = tenant.disclosurePosture ?? platformDefault
 *
 * **FAIL-OPEN, by design.** A null/undefined override — or a tenant row that could
 * not be read at all — resolves to the platform default rather than throwing. A
 * posture-lookup failure must never block a post: the posture governs whether we
 * *ask* for a declaration, and refusing the write would convert a policy-lookup
 * blip into an outage. Failing closed on the LABEL is a separate concern and lives
 * in `resolveProvenance` (max disclosure wins), which no posture can override.
 */
export declare function resolveDisclosurePosture(override: TenantPostureOverride | null | undefined, platformDefault: DisclosurePosture): DisclosurePosture;
/** What the compose UI must do about the declaration field, under this posture. */
export type DeclarationRequirement = 
/** Accept it if offered; never ask, never require. */
"none"
/** Ask, but "prefer not to say" (→ UNKNOWN) is an acceptable answer. */
 | "prompt"
/** A declaration must be present and must not be UNKNOWN. */
 | "mandatory";
export declare function declarationRequirement(posture: DisclosurePosture): DeclarationRequirement;
/** Why a declaration was rejected. Maps to an API error code at the boundary. */
export type DeclarationRejection = 
/** No `provenance` was supplied and the tenant requires one. */
"DECLARATION_REQUIRED"
/** `UNKNOWN` was supplied and the tenant does not accept "prefer not to say". */
 | "DECLARATION_MAY_NOT_BE_UNKNOWN";
/**
 * Validate an author's declaration against the tenant's posture, at write time.
 *
 * `declared` is the source type the author supplied, or `undefined` when the
 * request omitted the field entirely. The two are distinct: under
 * `REQUIRED_FOR_AI`, omitting the field and explicitly answering `UNKNOWN` are
 * both refused, but for different reasons and with different error codes, because
 * a client needs to tell "you forgot to ask" from "the user declined and you must
 * not let them".
 *
 * Returns null when the declaration is acceptable. Pure — the caller maps the
 * rejection onto an HTTP response.
 */
export declare function validateDeclaration(posture: DisclosurePosture, declared: string | undefined): DeclarationRejection | null;

// ===== lib/push/index.d.ts =====
export type { PushPlatformWire, PushDeviceTarget, PushSendOutcome, PushTransport, } from "./push-transport.js";
export { setPushTransportProvider, resolvePushTransport, __resetPushTransportProviderForTests, } from "./push-transport.js";
export { PushDispatcher, MAX_PUSH_DEVICES_PER_USER, platformToWire, } from "./push-dispatcher.js";
export type { PushDeviceStore, PushDispatchInput, PushDispatchResult, } from "./push-dispatcher.js";
export { PushDeviceHandler, wireToPlatform } from "./push-device-handler.js";
export type { RegisteredDeviceDto } from "./push-device-handler.js";
export { hashDeviceToken } from "./token-crypto.js";

// ===== lib/push/push-device-handler.d.ts =====
import type { PushPlatform } from "@prisma/client";
import type { Env } from "../../env.js";
import type { PushPlatformWire } from "./push-transport.js";
/** Wire platform → Prisma enum. */
export declare function wireToPlatform(wire: PushPlatformWire): PushPlatform;
export interface RegisteredDeviceDto {
    id: string;
    platform: PushPlatformWire;
    createdAt: string;
    lastSeenAt: string;
}
export declare class PushDeviceHandler {
    /**
     * Register (or refresh) a device token for the session user. Idempotent
     * upsert keyed on the deterministic tokenHash; a token currently held by
     * ANOTHER account is REASSIGNED (last registration wins — the
     * account-switch case, contract §1). Enforces the per-user device cap by
     * evicting the stalest rows. The raw token is stored AES-GCM encrypted and
     * is never returned.
     */
    registerDevice(userId: string, token: string, platform: PushPlatformWire, env: Env): Promise<RegisteredDeviceDto>;
    /**
     * Delete one of the session user's devices. Owner-scoped: the delete
     * predicate includes userId, so a foreign or unknown id deletes nothing.
     * Returns false in that case (route answers 404 — no existence oracle).
     */
    deleteDevice(userId: string, deviceId: string, env: Env): Promise<boolean>;
}

// ===== lib/push/push-dispatcher.d.ts =====
import type { PushPlatform } from "@prisma/client";
import type { Logger } from "../logger.js";
import type { WakeupKind } from "../realtime/push-notifier.js";
import type { PushPlatformWire, PushTransport } from "./push-transport.js";
/** Per-user registered-device cap (also enforced at registration). */
export declare const MAX_PUSH_DEVICES_PER_USER = 20;
/** Prisma enum → wire platform. */
export declare function platformToWire(platform: PushPlatform): PushPlatformWire;
/**
 * The slice of the Prisma client the dispatcher needs — structural, so unit
 * tests inject a plain mock and the dispatcher stays vendor-blind.
 */
export interface PushDeviceStore {
    pushDevice: {
        findMany(args: {
            where: {
                userId: string;
            };
            orderBy: {
                lastSeenAt: "desc";
            };
            take: number;
            select: {
                id: true;
                platform: true;
                tokenCiphertext: true;
            };
        }): Promise<Array<{
            id: string;
            platform: PushPlatform;
            tokenCiphertext: string;
        }>>;
        deleteMany(args: {
            where: {
                id: string;
            };
        }): Promise<{
            count: number;
        }>;
    };
}
export interface PushDispatchInput {
    /** Server-resolved recipient (never client-asserted). */
    userId: string;
    /** "safety" for ALWAYS_DELIVER types, else "wakeup" — same as PushNotifier. */
    kind: WakeupKind;
}
export interface PushDispatchResult {
    attempted: number;
    delivered: number;
    invalidated: number;
}
export declare class PushDispatcher {
    private readonly transport;
    private readonly logger;
    constructor(transport: PushTransport, logger: Logger);
    /**
     * Fan one content-free wakeup out to every registered device of the user.
     * NEVER throws; resolves with counters for observability.
     */
    dispatch(input: PushDispatchInput, db: PushDeviceStore, decryptionKey: string): Promise<PushDispatchResult>;
}

// ===== lib/push/push-transport.d.ts =====
/** Wire form of the PushPlatform enum ("apns" | "fcm" | "web"). */
export type PushPlatformWire = "apns" | "fcm" | "web";
/** One registered device the dispatcher resolved for a wakeup. */
export interface PushDeviceTarget {
    /** PushDevice.id — for invalidation bookkeeping in the transport's logs. */
    deviceId: string;
    platform: PushPlatformWire;
    /** Decrypted raw platform token. Never logged, never echoed to clients. */
    token: string;
}
/** Outcome of ONE send attempt to ONE device. */
export type PushSendOutcome = {
    ok: true;
} | {
    ok: false;
    reason: "unregistered" | "transient" | "config";
};
export interface PushTransport {
    /** Implementation label (e.g. "sns-platform", "fcm-v1") — logging only. */
    readonly kind: string;
    /** Deliver one content-free wakeup payload to one device. */
    send(device: PushDeviceTarget, payload: Uint8Array): Promise<PushSendOutcome>;
}
/**
 * Consuming app (Skybber) calls this at startup with its concrete transport
 * (e.g. an SNS-platform-endpoint adapter). MUST run before serving.
 */
export declare function setPushTransportProvider(transport: PushTransport): void;
/** Returns the injected transport, or undefined when none was registered. */
export declare function resolvePushTransport(): PushTransport | undefined;
/** Test-only: clear the injected provider so tests don't leak across cases. */
export declare function __resetPushTransportProviderForTests(): void;

// ===== lib/push/token-crypto.d.ts =====
export { encryptSecret, decryptSecret } from "../mfa/totp-service.js";
/** Deterministic SHA-256 hex of a raw device token — the dedupe/upsert key. */
export declare function hashDeviceToken(token: string): Promise<string>;

// ===== lib/realtime/channel.d.ts =====
import type { Channel, ChannelKind, VerifiedIdentity } from "./types.js";
/**
 * Produce the canonical channel path. This is the ONLY way a channel string is
 * minted server-side; the Skybber `@skybber/realtime-channels` parser must
 * round-trip this output.
 */
export declare function channelName(c: Channel): string;
/**
 * Parse a canonical channel path. Returns `null` on ANY malformed input — a
 * leading-slash-less path, wrong arity, unknown kind/scopeType, or an empty
 * segment.
 */
export declare function parseChannel(path: string): Channel | null;
/**
 * Build a user-scoped channel (v1: the only scope). `kind` is constrained to
 * the v1 user-scoped kinds; `message`/`thread` are deferred and excluded.
 */
export declare function channelFor(kind: Exclude<ChannelKind, "message" | "thread">, scope: {
    tenantId: string;
    userId: string;
}): Channel;
/**
 * THE security boundary. The channel is a client *assertion* this checks
 * against a server-verified identity.
 *
 * ALLOW iff `c.tenantId === id.tenantId` AND
 *   scopeType "user"             -> `c.scopeId === id.userId`
 *   scopeType conversation/thread -> membership(id.userId, c.scopeId) [v1: false]
 *
 * End-user PUBLISH is ALWAYS denied elsewhere (publish is server-only via IAM);
 * this function governs SUBSCRIBE only.
 */
export declare function authorizeSubscription(id: VerifiedIdentity, c: Channel): boolean;

// ===== lib/realtime/delivery-policy.d.ts =====
import type { DeliveryContext, DeliveryDecision, DeliveryPolicyResolver } from "./types.js";
import type { NotificationType } from "@prisma/client";
/**
 * Notification types that ALWAYS deliver — they bypass user preference and
 * quiet hours. Migrated verbatim from `notification-handler.ts`'s
 * `ALWAYS_DELIVER_TYPES`. This is the critical-always floor.
 */
export declare const ALWAYS_DELIVER_TYPES: ReadonlySet<NotificationType>;
/**
 * Track D runtime config for the floor. The minor-protection rule needs the set
 * of "manipulative re-engagement" NotificationTypes to deny to non-adults. Per
 * the threshold-secrecy invariant (CLAUDE.md rule 8) this list is RUNTIME CONFIG
 * — passed in here, never a compiled-in constant sprinkled at a call site.
 * v1 ships it EMPTY (no such type exists yet); a deployment populates it via env.
 */
export interface DeliveryFloorConfig {
    /** NotificationTypes that re-engage and are denied to non-adult recipients. */
    reengagementTypes?: ReadonlySet<NotificationType>;
}
/**
 * The WS1 + Track D default resolver. Pure and synchronous over `DeliveryContext`
 * (the caller does any async lookups and passes resolved signals in):
 *
 *  1. ALWAYS_DELIVER_TYPES (SAFETY_ALERT, PARENTAL_LINK) bypass everything ->
 *     `{ deliver: true }`. Safety must NOT be over-blocked: this wins over the
 *     blocked-sender and minor-protection floor below.
 *  2. Non-configurable FLOOR (checked only when the caller supplies the input):
 *       - blocked sender: the caller resolves block-set membership async (via
 *         BlockStore) and populates `ctx.senderUserId` ONLY when the sender is
 *         blocked — so presence of `senderUserId` == "in the recipient's block
 *         set". The decision is a hard drop no preference can override.
 *       - minor-protection: a non-adult recipient (`recipientAgeTier` CHILD/TEEN)
 *         targeted by a configured re-engagement type is dropped.
 *  3. Else honor preference (caller pre-resolves `deliver:false`/`preference`)
 *     and quiet hours.
 *
 * Note on preference: in the existing handler the type-preference check happens
 * BEFORE creating the row (preference-off => no row at all), which is a
 * different outcome from quiet-hours (row created with deliveredAt=null). The
 * caller maps the decision reasons accordingly. To keep the resolver pure and
 * total it accepts the preference outcome via `ctx` indirectly: the caller only
 * invokes the resolver's quiet-hours path once preference has passed. For a
 * single source of truth the resolver still exposes the full decision so a
 * push-only caller (WS4) can gate solely on it.
 */
export declare class CalmDeliveryResolver implements DeliveryPolicyResolver {
    private readonly reengagementTypes;
    constructor(config?: DeliveryFloorConfig);
    decide(ctx: DeliveryContext): DeliveryDecision;
}

// ===== lib/realtime/index.d.ts =====
export type { Channel, ChannelKind, ScopeType, VerifiedIdentity, DeliveryTarget, DeliveryResult, DeliveryContext, DeliveryDecision, QuietHoursConfig, WakeupEnvelope, EncryptedBlob, PutResult, SettingStore, ChangedSettingMeta, ChangeCursorStore, RealtimeTransport, DeliveryPolicyResolver, } from "./types.js";
export { encodeWakeup, decodeWakeup, supportsChangeCursor } from "./types.js";
export { channelName, parseChannel, channelFor, authorizeSubscription, } from "./channel.js";
export { CalmDeliveryResolver, ALWAYS_DELIVER_TYPES, } from "./delivery-policy.js";
export { InMemorySettingStore } from "./setting-store.js";
export { PollTransport } from "./poll-transport.js";
export { NoopRealtimeTransport } from "./no-op-transport.js";
import type { RealtimeTransport } from "./types.js";
/**
 * Consuming app (Skybber) calls this at startup with its concrete transport
 * (e.g. AppSyncEventsTransport). MUST run before buildEnv-consumers serve.
 */
export declare function setRealtimeProvider(transport: RealtimeTransport): void;
/**
 * Returns the injected transport if a provider was registered, else the
 * supplied fallback. `buildEnv` calls this with the default Poll/Noop transport.
 */
export declare function resolveRealtimeTransport(fallback: RealtimeTransport): RealtimeTransport;
/** Test-only: clear the injected provider so tests don't leak across cases. */
export declare function __resetRealtimeProviderForTests(): void;

// ===== lib/realtime/no-op-transport.d.ts =====
import type { Channel, DeliveryPolicyResolver, DeliveryResult, DeliveryTarget, EncryptedBlob, PutResult, RealtimeTransport } from "./types.js";
export declare class NoopRealtimeTransport implements RealtimeTransport {
    private readonly policy;
    readonly kind: "noop";
    constructor(policy: DeliveryPolicyResolver);
    deliver(target: DeliveryTarget, channel: Channel, _payload: Uint8Array): Promise<DeliveryResult>;
    getSetting(_userId: string, _namespace: string): Promise<EncryptedBlob | null>;
    putSetting(_userId: string, _namespace: string, _blob: EncryptedBlob, _expectVersion: number): Promise<PutResult>;
}

// ===== lib/realtime/poll-transport.d.ts =====
import type { Channel, DeliveryPolicyResolver, DeliveryResult, DeliveryTarget, EncryptedBlob, PutResult, RealtimeTransport, SettingStore } from "./types.js";
export declare class PollTransport implements RealtimeTransport {
    private readonly store;
    private readonly policy;
    readonly kind: "poll";
    constructor(store: SettingStore, policy: DeliveryPolicyResolver);
    deliver(target: DeliveryTarget, channel: Channel, _payload: Uint8Array): Promise<DeliveryResult>;
    getSetting(userId: string, namespace: string): Promise<EncryptedBlob | null>;
    putSetting(userId: string, namespace: string, blob: EncryptedBlob, expectVersion: number): Promise<PutResult>;
}

// ===== lib/realtime/push-notifier.d.ts =====
import type { Logger } from "../logger.js";
import type { ChannelKind, RealtimeTransport } from "./types.js";
/** The kinds WS4 routes a content-free notification wakeup onto. */
export type WakeupKind = Extract<ChannelKind, "wakeup" | "safety">;
export interface PushNotifierInput {
    /** Server-resolved recipient. */
    target: {
        userId: string;
        tenantId: string;
    };
    /**
     * Channel kind: ALWAYS_DELIVER notifications route to "safety" (the floor
     * channel), everything else to "wakeup". Constrained to the two content-free
     * kinds WS4 owns — there is no overload that accepts "message"/"thread".
     */
    kind: WakeupKind;
}
/**
 * Build the content-free wakeup payload for a notification. The envelope is the
 * frozen WS1 `WakeupEnvelope` and carries NO notification content — only the
 * envelope version and the channel kind. There is deliberately no `changeToken`
 * for notification wakeups (that field is the setting_sync version pointer); a
 * notification wakeup says only "something changed on this surface; refetch".
 */
export declare function buildNotificationWakeup(kind: WakeupKind): Uint8Array;
/**
 * Relay a content-free wakeup over the realtime transport, best-effort.
 *
 * Resolves to `true` if the transport reported a delivery, `false` otherwise
 * (policy-denied, no transport, transport error, or a thrown transport). NEVER
 * throws — the caller's persisted write is durable regardless.
 */
export declare class PushNotifier {
    private readonly transport;
    private readonly logger;
    constructor(transport: RealtimeTransport, logger: Logger);
    notify(input: PushNotifierInput): Promise<boolean>;
}

// ===== lib/realtime/setting-store.d.ts =====
import type { ChangeCursorStore, ChangedSettingMeta, EncryptedBlob, PutResult, SettingStore } from "./types.js";
export type { SettingStore };
/**
 * In-memory `SettingStore` with optimistic-concurrency semantics. Keyed by
 * `userId \0 namespace`. The server NEVER parses `ciphertext`.
 *
 * Optimistic concurrency:
 *  - First write of a (user, namespace) requires `expectVersion === 0`; a
 *    non-zero `expectVersion` against an absent record => `not_found`.
 *  - A write whose `expectVersion` does not equal the stored version =>
 *    `version_conflict` carrying the current blob for client-side merge.
 *  - On success the stored version is set to `expectVersion + 1` and
 *    `updatedAt` is server-assigned from the injectable clock.
 */
export declare class InMemorySettingStore implements SettingStore, ChangeCursorStore {
    private readonly now;
    private readonly store;
    constructor(now?: () => Date);
    private key;
    get(userId: string, namespace: string): Promise<EncryptedBlob | null>;
    put(userId: string, namespace: string, blob: EncryptedBlob, expectVersion: number): Promise<PutResult>;
    /**
     * Track C — offline backfill. Returns metadata for this user's namespaces whose
     * `version` advanced strictly past `sinceVersion`. METADATA ONLY: never carries
     * `ciphertext`. Sorted by ascending `version` so the caller can advance its
     * cursor to the last entry's `version`.
     */
    listChangedSince(userId: string, sinceVersion: number): Promise<ChangedSettingMeta[]>;
}

// ===== lib/realtime/types.d.ts =====
import type { NotificationType, AgeTier } from "@prisma/client";
/**
 * Coarse class of realtime traffic. Lets policy/transport route and rate-shape.
 * v1 ships ONLY the user-scoped kinds (`wakeup`, `setting_sync`, `safety`);
 * `message` and `thread` are taxonomy-reserved but unused (DEFERRED).
 */
export type ChannelKind = "wakeup" | "setting_sync" | "safety" | "message" | "thread";
/** The scope a channel addresses. v1 ships only `"user"`. */
export type ScopeType = "user" | "conversation" | "thread";
/**
 * A push-delivery channel — a content-free routing address, ALWAYS tenant- and
 * scope-bound and server-verified. The canonical string form is produced ONLY
 * by `channelName()` and parsed ONLY by `parseChannel()` (and the Skybber
 * `@skybber/realtime-channels` parser, which must round-trip them).
 *
 * FROZEN kind→scopeType map (v1 ships ONLY user-scoped kinds):
 *   wakeup | setting_sync | safety  -> scopeType "user",  scopeId = recipient userId
 *   message                         -> scopeType "conversation" (DEFERRED)
 *   thread                          -> scopeType "thread"        (DEFERRED)
 */
export interface Channel {
    kind: ChannelKind;
    /** Server-resolved tenant scope. */
    tenantId: string;
    scopeType: ScopeType;
    /** userId (v1) | conversationId | threadId (deferred). */
    scopeId: string;
}
/**
 * Verified identity. Derived ONLY from Cognito claims (custom:userId,
 * custom:activeTenantId) — by the in-core handler AND the Skybber authorizer
 * Lambda — so both call the SAME function. Never an ambient Session, never a
 * client-asserted path.
 */
export interface VerifiedIdentity {
    userId: string;
    tenantId: string;
}
/** Recipient address for `deliver()`. Both fields server-resolved. */
export interface DeliveryTarget {
    userId: string;
    tenantId: string;
}
/**
 * Result of a `deliver()` attempt. `deliver()` is BEST-EFFORT: it NEVER rejects
 * in a way that rolls back a persisted write. It resolves with this result;
 * transports catch their own errors. The policy fence runs INSIDE every
 * transport's `deliver()`.
 */
export type DeliveryResult = {
    delivered: true;
} | {
    delivered: false;
    reason: "policy_denied" | "no_transport" | "transport_error";
};
/**
 * Input the policy resolver sees. Built by the caller from its own args
 * (`createNotification` has no Session), enriched with recipient ageTier /
 * blocked-sender as needed for the floor.
 */
export interface DeliveryContext {
    type: NotificationType;
    recipientUserId: string;
    tenantId: string;
    /** blocked-sender floor input. */
    senderUserId?: string;
    /** minor-protection floor input. */
    recipientAgeTier?: AgeTier;
    now: Date;
    quietHours?: QuietHoursConfig | null;
}
/** What the resolver decided for ONE delivery attempt. */
export type DeliveryDecision = {
    deliver: true;
} | {
    deliver: false;
    reason: "preference" | "quiet_hours" | "blocked_sender" | "floor";
};
/**
 * Quiet-hours window. `start`/`end` are opaque to the contract; the resolver
 * that produced the context owns their interpretation. (The core resolver
 * encodes minutes-since-midnight as decimal strings to reproduce the existing
 * `User.quietHoursStart/End` integer behavior byte-identically.)
 */
export interface QuietHoursConfig {
    enabled: boolean;
    start: string;
    end: string;
}
/**
 * The ONLY shape push payloads for wakeup/setting_sync may take. It has NO
 * free-form field — content-free is a property of the TYPE, not a test
 * heuristic. WS4/WS5 are FORBIDDEN from constructing arbitrary Uint8Array for
 * these kinds; they must use `encodeWakeup()`.
 */
export interface WakeupEnvelope {
    v: 1;
    kind: ChannelKind;
    /** opaque version pointer for setting_sync (NOT ciphertext). */
    changeToken?: string;
}
/** Encode a wakeup envelope to its canonical content-free byte form. */
export declare function encodeWakeup(e: WakeupEnvelope): Uint8Array;
/** Decode a wakeup envelope. Throws on unknown fields or malformed input. */
export declare function decodeWakeup(b: Uint8Array): WakeupEnvelope;
/**
 * Opaque AEAD ciphertext + plaintext sync metadata. The server NEVER reads
 * `ciphertext`. `version`/`updatedAt` are deliberately plaintext (they leak
 * only THAT/WHEN a setting changed, not WHAT).
 */
export interface EncryptedBlob {
    /** Base64url AEAD ciphertext of the client's JSON document. */
    ciphertext: string;
    /** Monotonic per (userId, namespace). Drives optimistic concurrency. */
    version: number;
    /** ISO-8601; server-assigned on write. */
    updatedAt: string;
}
/**
 * Result of `putSetting` — optimistic-concurrency outcome. Never throws on
 * conflict; the caller (and ultimately the client) reconciles against
 * `current`.
 */
export type PutResult = {
    ok: true;
    stored: EncryptedBlob;
} | {
    ok: false;
    reason: "version_conflict";
    current: EncryptedBlob;
} | {
    ok: false;
    reason: "not_found";
    current: null;
};
/**
 * Minimal store port the transports use for blob sync. WS5 supplies
 * `PrismaEncryptedSettingsStore`; WS1 ships `InMemorySettingStore` so core
 * runs/tests with zero infra. Holds CIPHERTEXT ONLY.
 *
 * FROZEN (§2.5): do NOT add methods here. Offline-backfill (Track C) is layered
 * as the SEPARATE optional `ChangeCursorStore` capability below so this contract
 * stays byte-stable for every consumer bound to it.
 */
export interface SettingStore {
    get(userId: string, namespace: string): Promise<EncryptedBlob | null>;
    put(userId: string, namespace: string, blob: EncryptedBlob, expectVersion: number): Promise<PutResult>;
}
/**
 * Metadata for ONE namespace whose version advanced past a client's cursor.
 *
 * SERVER-BLIND: deliberately carries NO `ciphertext`. It leaks only THAT/WHEN a
 * namespace changed (already-plaintext sync metadata), never WHAT. A client that
 * sees its namespace here re-pulls the blob over the authenticated GET. The
 * absence of `ciphertext` is a TYPE-level guarantee, asserted by the tests.
 */
export interface ChangedSettingMeta {
    namespace: string;
    /** Monotonic per (userId, namespace) — the new high-watermark for this row. */
    version: number;
    /** ISO-8601 server-assigned write time. */
    updatedAt: string;
}
/**
 * OPTIONAL offline-backfill capability (Track C), layered ALONGSIDE the frozen
 * `SettingStore` rather than baked into it. A store MAY also implement this to
 * answer "which of my namespaces changed since I was last online?".
 *
 * The cursor (`sinceVersion`) is an opaque per-user version high-watermark: the
 * largest `version` the client has already observed across ALL its namespaces.
 * `listChangedSince` returns metadata for every namespace whose stored `version`
 * is strictly greater than that watermark — METADATA ONLY, never `ciphertext`.
 */
export interface ChangeCursorStore {
    listChangedSince(userId: string, sinceVersion: number): Promise<ChangedSettingMeta[]>;
}
/** Narrowing helper: does this store also provide the change-cursor capability? */
export declare function supportsChangeCursor(store: SettingStore): store is SettingStore & ChangeCursorStore;
/**
 * The capability seam. Core ships `PollTransport` (default) + `NoopRealtimeTransport`
 * (CI); a consuming app injects a concrete transport (e.g. Skybber's
 * `AppSyncEventsTransport`) via `setRealtimeProvider()` WITHOUT core ever
 * importing an AWS SDK.
 *
 * `subscribeInContext` is intentionally NOT part of the v1 freeze (in-context
 * liveness is messaging-era; adding an optional method later is non-breaking).
 */
export interface RealtimeTransport {
    readonly kind: "poll" | "appsync-events" | "noop";
    /** Best-effort push. Runs the policy fence (floor) internally, every transport. */
    deliver(target: DeliveryTarget, channel: Channel, payload: Uint8Array): Promise<DeliveryResult>;
    getSetting(userId: string, namespace: string): Promise<EncryptedBlob | null>;
    putSetting(userId: string, namespace: string, blob: EncryptedBlob, expectVersion: number): Promise<PutResult>;
    shutdown?(): Promise<void>;
}
/** The policy port. WS1 ships `CalmDeliveryResolver`; WS3 may layer it. */
export interface DeliveryPolicyResolver {
    decide(ctx: DeliveryContext): DeliveryDecision;
}

// ===== lib/region-detection.d.ts =====
/**
 * Region Detection Module
 *
 * Detects user region using multiple sources with priority ordering:
 * 1. User preference (from authenticated session) - Most trusted
 * 2. IP geolocation - Automatic detection
 * 3. Accept-Language header - Fallback
 * 4. Default region - Safe fallback
 *
 * Security: All detected regions are validated against known regions list.
 *
 * ## Foundation adoption
 *
 * The pure header / Accept-Language parsing is delegated to
 * `@de-otio/saas-foundation/region`'s `RegionDetector`, configured via the
 * trellis `RegionRegistry` in `region-registry.ts`. This module keeps:
 *   - trellis's literal `Region` union (`"US" | "EU" | "CN"`),
 *   - `isValidRegion` validating against that union,
 *   - the env-driven `DEFAULT_REGION` handling,
 *   - the legacy "unlisted CDN country -> EU" catch-all policy,
 *   - the trellis-specific user-preference DB lookup, session handling, and
 *     external IP-geolocation fallback.
 *
 * Foundation's `Region` is a generic branded string; by construction the
 * trellis registry only ever yields US/EU/CN, so results are coerced back to
 * the literal union via `coerceRegion`.
 */
import type { Env } from "../env.js";
import { Session, SessionManager } from "./session-cookie.js";
/**
 * Valid regions supported by the application
 */
declare const VALID_REGIONS: readonly ["US", "EU", "CN"];
export type Region = (typeof VALID_REGIONS)[number];
/**
 * Re-export `Env` for the legacy `region-config.ts` / extended-test imports
 * that pull the env shape from this module.
 */
export type { Env } from "../env.js";
/**
 * Region Detector class
 */
export declare class RegionDetector {
    private env;
    private logger;
    constructor(env: Env);
    /**
     * Validate region against known regions list
     *
     * Security: Prevents region spoofing by only allowing known regions
     *
     * @param region - Region code to validate
     * @returns true if region is valid, false otherwise
     */
    isValidRegion(region: string): region is Region;
    /**
     * Resolve the effective default region from env.
     *
     * Mirrors the legacy behaviour: an invalid `DEFAULT_REGION` falls back to
     * `EU` (the GDPR-safe default), NOT to the raw env value.
     */
    private resolveDefaultRegion;
    /**
     * Map a CDN geolocation header to a region.
     *
     * Reads CloudFront-Viewer-Country (preferred) then CF-IPCountry (legacy
     * Cloudflare fallback). Unknown markers (XX, T1) yield `null`. Mapped
     * countries route via the foundation registry; any other present,
     * non-unknown country defaults to EU per the legacy GDPR-safe policy.
     *
     * @param request - Request object (contains geo headers)
     * @returns Region code or null if no usable CDN country header
     */
    private geolocateIPFromHeaders;
    /**
     * Detect a region from the Accept-Language header.
     *
     * Parses the language tags and resolves each to a region via the foundation
     * registry's `countryToRegion`. The language->country heuristic is a
     * trellis domain rule (which languages imply which markets), so it stays
     * local; only the country->region resolution is delegated to foundation.
     *
     * Foundation's own `RegionDetector` cannot be used directly here because its
     * `detectSync` always falls through to the registry default when no language
     * matches, which would mask the "no match" case this priority chain relies
     * on to continue to the env default.
     *
     * Returns `null` when no language maps (so the caller's chain continues).
     */
    private getRegionFromLanguage;
    /**
     * Geolocate IP address using external service (fallback)
     *
     * Only used if CDN geolocation headers are not available
     *
     * @param ip - IP address to geolocate
     * @returns Region code or null if not detected
     */
    private geolocateIPExternal;
    /**
     * Detect user region from request (optimized async version)
     *
     * Priority order (most trusted first):
     * 1. User preference (from authenticated session)
     * 2. IP geolocation (CloudFront-Viewer-Country / CF-IPCountry header)
     * 3. Accept-Language header
     * 4. Default region
     *
     * Security: All detected regions are validated against known regions list
     *
     * @param request - Request object
     * @param sessionManager - Session manager instance (optional, for user preference)
     * @param session - Existing session (optional, to avoid re-fetching)
     * @returns Detected region code (always valid)
     */
    detectRegion(request: Request, sessionManager?: SessionManager, session?: Session | null): Promise<Region>;
    /**
     * Synchronous version of detectRegion (for cases where async is not needed)
     *
     * Uses only:
     * - CloudFront-Viewer-Country / CF-IPCountry header (synchronous)
     * - Accept-Language header (synchronous)
     * - Default region (synchronous)
     *
     * Does NOT use:
     * - User session (requires async)
     * - External IP geolocation (requires async)
     *
     * @param request - Request object
     * @returns Detected region code (always valid)
     */
    detectRegionSync(request: Request): Region;
}
/**
 * Legacy functions for backward compatibility
 * @deprecated Use new RegionDetector class instead
 */
export declare function isValidRegion(region: string): region is Region;
export declare function detectRegion(request: Request, env: Env, sessionManager?: SessionManager, session?: Session | null): Promise<Region>;
export declare function detectRegionSync(request: Request, env: Env): Region;

// ===== lib/session-cookie.d.ts =====
/**
 * Session Management
 *
 * Handles encrypted cookie-based session storage for authentication.
 *
 * Crypto is delegated to `@de-otio/saas-foundation/session`'s
 * `SessionCookie` (AES-256-GCM, 96-bit random IV, PBKDF2-SHA256 with
 * the OWASP-2023 600k-iteration minimum). The envelope format is
 * base64([IV || ciphertext+tag]) — identical in shape to the previous
 * hand-rolled implementation, only the derived key is stronger.
 *
 * This module is a thin trellis-flavoured wrapper: it preserves the
 * `SessionManager` public surface (so the ~60 call sites only change
 * their import path), owns the trellis `Session` shape + custom-claim
 * validation (foundation is payload-agnostic), and keeps the AUTH-5
 * token-revocation blocklist (which has no foundation equivalent).
 */
import type { AgeTier } from "@prisma/client";
import { MIN_SALT_LENGTH, MIN_SECRET_LENGTH } from "@de-otio/saas-foundation/session";
export type UserRole = "END_USER" | "B2B_PARTNER" | "PARTNER_ADMIN" | "INTERNAL" | "CONTENT_CREATOR" | "SUPER_ADMIN";
export interface Session {
    userId: string;
    email: string;
    role?: UserRole;
    expiresAt: number;
    csrfToken?: string;
    csrfTokenCreatedAt?: number;
    csrfTokenNeedsRotation?: boolean;
    lastActivityAt?: number;
    sessionType?: "user" | "sso" | "dashboard";
    dataRegion: string;
    profileContext: "primary" | "decoy";
    contextId?: string;
    mfaVerified?: boolean;
    mfaVerifiedAt?: number;
    ageTier?: AgeTier;
    sessionEpoch?: number;
    activeTenantId?: string;
}
/**
 * Test-only: clear the module-scope `SessionCookie` cache so KDF-count
 * assertions and benchmarks start cold. Not part of the public API.
 * @internal
 */
export declare function __clearSessionCookieCacheForTesting(): void;
/**
 * Session Manager class for handling encrypted sessions.
 */
export declare class SessionManager {
    private static readonly COOKIE_NAME;
    hadLegacySessionCookie: boolean;
    hadInvalidSessionCookie: boolean;
    /**
     * Get the foundation `SessionCookie` for a secret/fallback/salt
     * triple. Delegates to the module-scope cache (see
     * `moduleCookieCache` above) so the derived AES key is reused across
     * requests even though `SessionManager` itself is constructed
     * per-request.
     */
    private getCookie;
    /**
     * Get session configuration from environment
     */
    private getSessionConfig;
    /**
     * Encrypt session data using foundation's AES-256-GCM SessionCookie.
     *
     * `salt` is required (mirrors foundation MIN_SALT_LENGTH); omitting
     * it fails closed with a SESSION_SALT error.
     *
     * O-1 / 05a `[SR:H3]`: this is the single seal chokepoint (every seal path —
     * `setSession`, and the CSRF/MFA re-seal sites — routes its payload through
     * here), so it is also the single place that guarantees `activeTenantId` is
     * never persisted in sealed material. A JWT-derived `Session` carries a
     * trusted `activeTenantId`; if that object is fed back into a 90-day cookie /
     * localStorage token (as the CSRF-refresh and MFA-verify handlers do), the
     * tenant would outlive the ≤1h token it was verified from — letting a user
     * removed from a tenant keep minting a scoped handle for it. Stripping here
     * enforces "verified-per-request only" for every caller, present and future,
     * instead of relying on each seal site to remember.
     */
    encryptSession(data: string, secret: string, salt?: string): Promise<string>;
    /**
     * Decrypt session data. Returns null on any decryption failure
     * (bad MAC, wrong key, malformed input).
     */
    decryptSession(encryptedData: string, secret: string, salt?: string): Promise<string | null>;
    /**
     * Validate and narrow a decrypted/parsed payload into a trellis
     * `Session`. Returns null (and sets `hadInvalidSessionCookie`) when
     * the payload is not a valid Supabase session, or is a legacy
     * BlueSky/AT-Protocol session.
     */
    private narrowSession;
    /**
     * Get session from request
     * Checks Authorization header first (for localStorage token), then falls back to cookie
     * Checks expiration and inactivity timeout
     *
     * Supports dual-secret rotation: tries primary secret first, then fallback secret
     * This enables zero-downtime secret rotation without invalidating existing sessions
     */
    getSession(request: Request, secret: string, env?: {
        [key: string]: any;
    }): Promise<Session | null>;
    /**
     * Narrow a payload parsed from the Authorization-header path. This
     * path historically accepted any object with userId + email and did
     * NOT set hadInvalidSessionCookie, so we keep that behaviour distinct
     * from the cookie path's narrowSession.
     */
    private narrowSessionForAuthHeader;
    /**
     * Decrypt a token trying the primary secret first, then the fallback
     * secret (zero-downtime rotation). Foundation's `SessionCookie`
     * already tries primary→fallback internally when both are configured
     * on one instance, so we construct a single cookie with both.
     */
    private unsealWithRotation;
    /**
     * Set session cookie in response (alias for setSession)
     */
    setSessionCookie(response: Response, session: Session, secret: string, cookieDomain?: string, env?: {
        [key: string]: any;
    }): Promise<Response>;
    /**
     * Set session cookie in response
     * Uses configurable session timeout based on session type
     */
    setSession(response: Response, session: Session, secret: string, cookieDomain?: string, env?: {
        [key: string]: any;
    }): Promise<Response>;
    /**
     * Clear session cookie (alias for clearSession)
     */
    clearSessionCookie(response: Response): Response;
    /**
     * Clear session cookie
     * @param response - Response to add clear cookie headers to
     * @param cookieDomain - Optional domain to clear cookie from (e.g., ".example.com" for cross-subdomain)
     */
    clearSession(response: Response, cookieDomain?: string): Response;
    /**
     * Phase 8 — inactivity-timeout check, FAIL CLOSED on a missing timestamp.
     *
     * Previously guarded by `if (env && session.lastActivityAt)`: a sealed
     * payload that simply omitted `lastActivityAt` skipped the check entirely, so
     * the inactivity timeout was advisory — any client (or any code path that
     * sealed a session without the field) opted out of it for free.
     *
     * The effective "last seen" is `lastActivityAt`, falling back to the seal-time
     * `sessionEpoch` (stamped by `setSession`, i.e. the issue time — the plan's
     * "default missing lastActivityAt to issue time"). When NEITHER is present —
     * only possible for a cookie sealed before this change — the session is
     * treated as inactive and rejected, forcing one re-authentication rather than
     * grandfathering an unbounded-idle session.
     *
     * Returns `true` when the session must be rejected.
     */
    private isInactive;
    /**
     * SEC L2 — is this raw token on the revocation blocklist?
     *
     * Returns `true` (⇒ deny) when the token is blocked OR when the check could
     * not be completed. Failing CLOSED is the point of the finding: a
     * best-effort blocklist that silently allows on a KV outage is a blocklist an
     * attacker can bypass by causing (or waiting for) an outage.
     *
     * Configuration note: when NO blocklist KV is bound at all, the check is a
     * no-op (returns `false`). That is a deployment shape — local dev and the
     * unit-test envs bind no KV — not an outage, and treating it as a denial
     * would make trellis unusable without a KV. Operators who want the strict
     * reading set `SESSION_BLOCKLIST_REQUIRED=true`, which turns a missing
     * binding into a denial as well.
     */
    private isTokenRevoked;
    /**
     * SEC L2 — has this user's session epoch been bumped since the session was
     * sealed ("revoke all sessions")?
     *
     * Returns `true` (⇒ deny) when the sealed epoch is older than the stored one,
     * and when the lookup fails (fail closed). A sealed session predating this
     * change carries no `sessionEpoch`; it is treated as epoch 0, so any stored
     * epoch invalidates it — which is exactly the intent of a revoke-all.
     */
    private isEpochStale;
    /**
     * SEC L2 — combined post-verification gate for a SEALED session (cookie or
     * localStorage token): blocklist + epoch. Returns `true` when the session
     * must be rejected.
     */
    private isSealedSessionRevoked;
    /**
     * AUTH-5: Hash a session token for blocklist storage.
     */
    private hashToken;
    /**
     * AUTH-5: Revoke a session token by adding it to the blocklist.
     * Call this on logout to prevent token reuse.
     *
     * No foundation equivalent exists — this composes over the trellis
     * blocklist KV store and is kept verbatim.
     */
    revokeSession(request: Request, env: {
        [key: string]: any;
    }): Promise<void>;
    /**
     * SEC L2: revoke EVERY session for a user ("log out everywhere") by bumping
     * the stored session epoch. Any sealed session whose `sessionEpoch` predates
     * the bump is rejected by `getSession`.
     *
     * Call this on password/credential change, on account suspension, and from
     * the user-facing "sign out of all devices" action. Without it the only
     * global kill switch was rotating `SESSION_SECRET`, which logs out everyone.
     *
     * Throws if the KV write fails — the caller must not report success for a
     * revocation that did not persist.
     */
    revokeAllSessions(userId: string, env: {
        [key: string]: any;
    }): Promise<void>;
}
export { MIN_SECRET_LENGTH, MIN_SALT_LENGTH };

// ===== server.d.ts =====
/**
 * HTTP Server Entry Point
 *
 * Wraps the existing route handlers (originally for Cloudflare Workers) in a
 * Node.js HTTP server. Converts Node IncomingMessage <-> Web Fetch API Request/Response
 * so all handler code works unchanged.
 *
 * Verticals call registerExtension() before startServer().
 * See the Trellis repo for an example.
 */
import http from "node:http";
import { type ExtensionModelRegistryEntry } from "./lib/extension-model-registry.js";
/** Options for {@link startServer}. */
export interface StartServerOptions {
    /**
     * Composed extension-owned-model registry, produced by the schema composer
     * for an app that owns `ext_*` tables. Injected at boot and frozen before the
     * listener binds. Omit when no extension owns tables (the default).
     */
    readonly extensionModelRegistry?: readonly ExtensionModelRegistryEntry[];
}
export declare function startServer(options?: StartServerOptions): Promise<http.Server>;

// ===== shutdown.d.ts =====
/**
 * Graceful shutdown of the process-wide resources core owns.
 *
 * Core opens two pools lazily and holds them in module state: the shared
 * database connection manager (Prisma clients + pg pools) and the shared graph
 * service. Neither had a public entry point, so every consumer that needed to
 * release them — a standalone test lane, a script, a worker that boots the app
 * out of process — reached into `dist/lib/…` for the internals:
 *
 * ```ts
 * // what a consumer had to write, and what this replaces
 * const { sharedDatabaseConnectionManager } = await import(
 *   "@de-otio/trellis/dist/lib/database-connection-manager.js");
 * await sharedDatabaseConnectionManager.shutdown();
 * ```
 *
 * That is a false-affordance of the same family the `exports` map closes: the
 * only way to do a supported thing was to import an unsupported path. It also
 * blocks curating `dist/**` behind named subpaths, because those deep
 * specifiers are load-bearing for anyone running the server outside a
 * container.
 *
 * **Best-effort by construction.** Each step is attempted independently and a
 * failure in one does not prevent the others — a teardown that throws halfway
 * leaves sockets open, which is the problem it exists to solve. Failures are
 * returned rather than thrown so a caller that cares can report them.
 *
 * Idempotent: calling it twice is safe, and calling it when nothing was ever
 * opened is a no-op.
 */
/** What `shutdownTrellis()` managed to close, and what it could not. */
export interface ShutdownResult {
    /** Names of the subsystems that shut down cleanly. */
    closed: string[];
    /**
     * Subsystems that threw, with the error. Non-empty does NOT mean the process
     * is unhealthy — a pool that was never opened can fail to close.
     */
    failed: {
        subsystem: string;
        error: unknown;
    }[];
}
/**
 * Release core's process-wide resources so the process can exit.
 *
 * Call from a `SIGTERM` handler, a test lane's teardown, or any script that
 * booted the server in-process. Does **not** stop an HTTP server — close the
 * `Server` returned by {@link startServer} first, then call this.
 *
 * @example
 * ```ts
 * const server = await startServer();
 * // …
 * server.closeAllConnections?.();
 * await new Promise<void>((r) => server.close(() => r()));
 * await shutdownTrellis();
 * ```
 */
export declare function shutdownTrellis(): Promise<ShutdownResult>;

// ===== types/cloudflare-compat.d.ts =====
/**
 * Compatibility type shims for code migrated from Cloudflare Workers.
 * These types match the Cloudflare interfaces so migrated code works unchanged.
 */
export type { KVNamespace, KvPutOptions, KvListOptions, KvListResult, } from "@de-otio/saas-foundation/kv";
export type { Queue, Queue as CloudflareQueue, QueueSendOptions, QueueBatchEntry, } from "@de-otio/saas-foundation/queue";
export type { R2Bucket, R2Object, R2ObjectBody, R2PutOptions, R2ListResult, R2HttpMetadata, } from "@de-otio/saas-foundation/storage";
/** Cloudflare ExecutionContext — used for ctx.waitUntil() */
export interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
}
/** Minimal AnalyticsEngineDataset shim */
export interface AnalyticsEngineDataset {
    writeDataPoint(data: {
        blobs?: string[];
        doubles?: number[];
        indexes?: string[];
    }): void;
}
/** Minimal Hyperdrive shim (unused in AWS, only for type compatibility) */
export interface Hyperdrive {
    connectionString: string;
}
/** Cloudflare Queue MessageBatch — used by queue consumer handlers */
export interface Message<T = unknown> {
    id: string;
    timestamp: Date;
    body: T;
    ack(): void;
    retry(): void;
}
export interface MessageBatch<T = unknown> {
    queue: string;
    messages: Message<T>[];
    ackAll(): void;
    retryAll(): void;
}
/** Cloudflare Cron ScheduledEvent */
export interface ScheduledEvent {
    scheduledTime: number;
    cron: string;
}
