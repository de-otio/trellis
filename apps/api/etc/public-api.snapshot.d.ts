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
export { setRealtimeProvider } from "./lib/realtime/index.js";
export { setPushTransportProvider } from "./lib/push/index.js";
export type { PushTransport, PushDeviceTarget, PushSendOutcome, PushPlatformWire, } from "./lib/push/index.js";
export { setMediaModerationProvider } from "./lib/media/request-moderation.js";
export { setTextModerationProvider } from "./lib/media/request-text-moderation.js";

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

// ===== lib/media/moderation-provider.d.ts =====
import type { ModerationDecision } from "./media-lifecycle.js";
export type { ModerationDecision };
/** An opaque reference to an already-stored image object (key + bucket handle). */
export interface ImageRef {
    readonly bucket: string;
    readonly key: string;
}
/** An opaque reference to an already-stored object in S3-compatible storage. */
export interface S3Ref {
    readonly bucket: string;
    readonly key: string;
    /**
     * Pin the reference to an EXACT stored object version (AR-SEC F3). When set,
     * the provider adapter must moderate that specific version (Rekognition:
     * `Video.S3Object.Version`), so a later overwrite of the same key can never
     * change what a started job actually scanned.
     */
    readonly versionId?: string;
}
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
}
/**
 * The one canonical moderation seam. Image moderation is sync-ish (resolves a
 * verdict directly); video moderation is async (start → poll), mirroring the
 * cloud provider's job model. Audio reuses the text-moderation path and adds no
 * method here.
 */
export interface MediaModerationProvider {
    /** Synchronous-style image moderation: resolves a verdict directly. */
    moderateImage(input: ImageRef): Promise<ModerationVerdict>;
    /** Kicks off async video moderation; returns a handle to poll. */
    startVideoModeration(input: S3Ref): Promise<{
        jobId: string;
    }>;
    /** Polls a previously-started video moderation job for its verdict. */
    getVideoModeration(jobId: string): Promise<ModerationVerdict>;
}
export type WarnSink = (message: string, data?: unknown) => void;
/**
 * A verdict that fails closed: every call resolves to `review` with no labels.
 * Nothing this provider returns can ever auto-approve media. Used as the safe
 * default before a concrete provider is injected (dev only — see the startup
 * guard below).
 */
export declare class NullModerationProvider implements MediaModerationProvider {
    private readonly warn;
    constructor(warn?: WarnSink);
    private failClosed;
    moderateImage(_input: ImageRef): Promise<ModerationVerdict>;
    startVideoModeration(_input: S3Ref): Promise<{
        jobId: string;
    }>;
    getVideoModeration(_jobId: string): Promise<ModerationVerdict>;
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
    private imageVerdict;
    private videoVerdict;
    private jobIdSeq;
    constructor(canned?: {
        image?: ModerationVerdict;
        video?: ModerationVerdict;
    });
    /** Program the verdict returned by `moderateImage`. */
    setImageVerdict(verdict: ModerationVerdict): void;
    /** Program the verdict returned by `getVideoModeration`. */
    setVideoVerdict(verdict: ModerationVerdict): void;
    moderateImage(_input: ImageRef): Promise<ModerationVerdict>;
    startVideoModeration(_input: S3Ref): Promise<{
        jobId: string;
    }>;
    getVideoModeration(_jobId: string): Promise<ModerationVerdict>;
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

// ===== lib/media/request-moderation.d.ts =====
import { type MediaModerationProvider } from "./moderation-provider.js";
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
