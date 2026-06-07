/**
 * Environment Configuration
 *
 * Builds the application environment from process.env + AWS service adapters.
 * Shaped to be compatible with the existing handler code that expects CF-style bindings.
 */

import { DynamoKv, createDefaultDynamoClient } from "@de-otio/saas-foundation/kv";
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

const stage = process.env.STAGE || "dev";

function sqsUrl(queueName: string): string {
  const base = process.env.SQS_ENDPOINT || `https://sqs.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com`;
  const accountId = process.env.AWS_ACCOUNT_ID || "000000000000";
  return `${base}/${accountId}/${stage}-${queueName}`;
}

/** Application environment — available to all route handlers */
export interface Env {
  // Database
  DATABASE_URL: string;
  DATABASE_URL_CN?: string;
  DIRECT_URL?: string;
  DATABASE_POOL_MAX?: string;
  DATABASE_CONNECTION_TIMEOUT_MS?: string;
  DATABASE_STATEMENT_TIMEOUT_MS?: string;

  // Auth
  SESSION_SECRET: string;
  SESSION_SECRET_FALLBACK?: string;
  SESSION_SALT?: string;
  COGNITO_USER_POOL_ID?: string;
  COGNITO_APP_CLIENT_ID?: string;
  COGNITO_REGION?: string;
  COGNITO_HOSTED_UI_DOMAIN?: string;
  COGNITO_REDIRECT_URI?: string;

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
  EMAIL_SERVICE?: "aws-ses" | "resend" | "alibaba-directmail" | "tencent-ses";
  EMAIL_SERVICE_REGION?: string;
  FROM_EMAIL?: string;
  AWS_SES_REGION?: string;
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
  FRIENDS_KV: KVNamespace;
  CONNECTION_CODES_KV: KVNamespace;
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
  MEDIA_RECONCILIATION_QUEUE: CloudflareQueue;

  // Storage (S3-backed, same interface as Cloudflare R2)
  MEDIA_BUCKET_R2: R2Bucket;
  EXPORT_FILES_R2: R2Bucket;

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

  if (!env.COGNITO_USER_POOL_ID) {
    errors.push("COGNITO_USER_POOL_ID is required");
  }

  if (!env.COGNITO_APP_CLIENT_ID) {
    errors.push("COGNITO_APP_CLIENT_ID is required");
  }

  return errors;
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

  const kvCursorSecret = sessionSecret || process.env.CURSOR_SECRET;
  const kv = (namespace: string) =>
    new DynamoKv(dynamoClient, {
      tableName: kvTableName,
      namespace,
      ...(kvCursorSecret ? { cursorSecret: kvCursorSecret } : {}),
    });

  // Resolve DB URL: local DATABASE_URL wins; else fetch from Secrets Manager at
  // runtime. The resulting string stays on the returned Env object only — we do
  // NOT write it to process.env so it can't leak through env-var exposure.
  const databaseUrl = await resolveDatabaseUrl();

  return {
    DATABASE_URL: databaseUrl,
    DATABASE_URL_CN: process.env.DATABASE_URL_CN,
    DIRECT_URL: process.env.DIRECT_URL,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
    DATABASE_CONNECTION_TIMEOUT_MS: process.env.DATABASE_CONNECTION_TIMEOUT_MS,
    DATABASE_STATEMENT_TIMEOUT_MS: process.env.DATABASE_STATEMENT_TIMEOUT_MS,

    // Auth
    SESSION_SECRET: sessionSecret,
    SESSION_SECRET_FALLBACK: sessionSecretFallback,
    SESSION_SALT: process.env.SESSION_SALT,
    COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
    COGNITO_APP_CLIENT_ID: process.env.COGNITO_APP_CLIENT_ID,
    COGNITO_REGION: process.env.COGNITO_REGION || process.env.AWS_REGION || "us-east-1",
    COGNITO_HOSTED_UI_DOMAIN: process.env.COGNITO_HOSTED_UI_DOMAIN,
    COGNITO_REDIRECT_URI: process.env.COGNITO_REDIRECT_URI,

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
    ACTIVITYPUB_BASE_URL: process.env.ACTIVITYPUB_BASE_URL,
    // Federation master switch — fail closed: anything other than the exact
    // string "true" leaves federation disabled.
    ACTIVITYPUB_ENABLED: process.env.ACTIVITYPUB_ENABLED === "true",

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
    AWS_SES_REGION: process.env.AWS_SES_REGION || process.env.AWS_REGION || "us-east-1",
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
    FRIENDS_KV: kv("friends"),
    CONNECTION_CODES_KV: kv("connections"),
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
    MEDIA_RECONCILIATION_QUEUE: new SqsQueue(sqsClient, sqsUrl("media-reconciliation")),

    // S3 buckets (R2 interface)
    MEDIA_BUCKET_R2: new S3Storage(s3Client, mediaBucket),
    EXPORT_FILES_R2: new S3Storage(s3Client, exportsBucket),
  };
}
