/**
 * Boot-time environment validation (AR12).
 *
 * A Zod schema over the RAW `process.env` strings, checked once at startup
 * (`startServer()` in server.ts) BEFORE any AWS client is constructed or any
 * secret is resolved. A missing or malformed key fails the boot immediately
 * with a message that names the key — instead of surfacing later as a runtime
 * 500 found via post-deploy e2e.
 *
 * Tiers (incremental by design — this is boot validation only, not the full
 * `Env`-slicing refactor; that larger follow-up is filed as
 * `analysis/fable-analysis/architecture-review/02-architecture-traps.md §7.1`
 * in the skybber repo):
 *
 *   1. Required in every stage: database config (one of the three accepted
 *      forms), the session secret (value or ARN), and the Cognito pool/client
 *      ids (mirrors the existing post-build `validateEnv()` S1.4 checks).
 *   2. Dev-only-overridable — REQUIRED in prod, optional in dev/test:
 *      `SESSION_SALT` and `MEDIA_THRESHOLDS_JSON` (the media-moderation gate;
 *      absent in dev every category fail-closes to "review", which is safe for
 *      local work but never the intent of a prod deploy).
 *   3. Optional keys validated for FORMAT when set (any stage): the numeric
 *      MEDIA_* caps/limits, the MEDIA_*_JSON allowlists/presets,
 *      `MEDIA_CANONICAL_FORMAT`/`_QUALITY`, and `ACTIVITYPUB_ENABLED`.
 *      Previously an unparsable value was silently replaced by a dev default
 *      (or fail-closed) at runtime; at boot we treat it as operator misconfig
 *      and refuse to start. The runtime resolvers in env.ts keep their
 *      fail-closed fallbacks unchanged (defense in depth).
 *
 * Stage detection matches env.ts: `STAGE === "prod"` is prod; anything else
 * (unset, "dev", "test", …) gets the lenient dev rules.
 *
 * NOT part of the published public API: `src/index.ts` (the `@de-otio/trellis`
 * entry point) does not re-export this module; `startServer()` behavior for a
 * correctly configured environment is unchanged.
 */

import { z } from "zod";

/** Boot-validation stage mode. Only "prod" enables the strict tier. */
export type BootStage = "prod" | "dev";

/** Resolve the boot stage from the environment (same source env.ts uses). */
export function resolveBootStage(
  env: Record<string, string | undefined> = process.env,
): BootStage {
  return env.STAGE === "prod" ? "prod" : "dev";
}

/** Error thrown by {@link assertBootEnv}; `issues` each name the offending key. */
export class EnvBootValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Environment validation failed at boot (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n` +
        issues.map((i) => `  - ${i}`).join("\n"),
    );
    this.name = "EnvBootValidationError";
    this.issues = issues;
  }
}

// ── field-format helpers (checked only when the var is set) ──────────────────

const positiveIntString = z
  .string()
  .refine(
    (raw) => /^\d+$/.test(raw.trim()) && Number.parseInt(raw, 10) > 0,
    { message: "must be a positive integer" },
  );

const qualityString = z
  .string()
  .refine(
    (raw) => {
      if (!/^\d+$/.test(raw.trim())) return false;
      const n = Number.parseInt(raw, 10);
      return n >= 1 && n <= 100;
    },
    { message: "must be an integer between 1 and 100" },
  );

const jsonStringArray = z.string().refine(
  (raw) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.every((x) => typeof x === "string");
    } catch {
      return false;
    }
  },
  { message: "must be a JSON array of strings" },
);

/**
 * MEDIA_THRESHOLDS_JSON: a JSON object mapping category → { review, quarantine }
 * with both confidences in [0, 1]. The runtime parser silently DROPS invalid
 * entries (fail-closed to "review"); at boot an invalid entry is operator
 * misconfig and is rejected by name. `requireNonEmpty` is the prod rule — an
 * empty map in prod means the operator forgot to inject the SSM value.
 */
function mediaThresholdsJson(requireNonEmpty: boolean) {
  return z.string().superRefine((raw, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be valid JSON" });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      ctx.addIssue({
        code: "custom",
        message: 'must be a JSON object mapping category → { "review": 0..1, "quarantine": 0..1 }',
      });
      return;
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (requireNonEmpty && entries.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "must contain at least one category entry in prod (empty map means the SSM value was not injected)",
      });
      return;
    }
    for (const [category, value] of entries) {
      const v = value as { review?: unknown; quarantine?: unknown } | null;
      const ok =
        typeof v === "object" &&
        v !== null &&
        !Array.isArray(v) &&
        typeof v.review === "number" &&
        typeof v.quarantine === "number" &&
        v.review >= 0 &&
        v.review <= 1 &&
        v.quarantine >= 0 &&
        v.quarantine <= 1;
      if (!ok) {
        ctx.addIssue({
          code: "custom",
          message: `entry "${category}" is invalid — review and quarantine must be numbers in [0, 1]`,
        });
      }
    }
  });
}

// ── the schema ────────────────────────────────────────────────────────────────

/**
 * Build the boot-env Zod schema for a stage. All fields are `.optional()` at
 * the field level; REQUIREDNESS (including the either-or groups and the
 * prod-only tier) lives in `superRefine` so every failure carries an explicit,
 * operator-actionable message that names the key and its alternatives.
 */
export function buildBootEnvSchema(stage: BootStage) {
  const prod = stage === "prod";

  return z
    .object({
      // Tier 1 fields (requiredness enforced in superRefine below)
      DATABASE_URL: z
        .string()
        .regex(/^postgres(ql)?:\/\//, {
          message: "must be a postgres:// or postgresql:// connection URL",
        })
        .optional(),
      DB_SECRET_ARN: z.string().min(1).optional(),
      DB_SECRET_USERNAME: z.string().min(1).optional(),
      DB_SECRET_PASSWORD: z.string().min(1).optional(),
      DB_SECRET_HOST: z.string().min(1).optional(),

      SESSION_SECRET: z
        .string()
        .min(32, { message: "must be at least 32 characters" })
        .optional(),
      SESSION_SECRET_ARN: z.string().min(1).optional(),
      SESSION_SALT: z.string().min(1).optional(),

      COGNITO_USER_POOL_ID: z.string().min(1).optional(),
      COGNITO_APP_CLIENT_ID: z.string().min(1).optional(),

      // Generic OIDC verification (WS-3.1) — additive, default-derived from
      // COGNITO_*. Requiredness/SSRF rules live in superRefine + the SEC-4 boot
      // guard (lib/auth/auth-config.ts).
      AUTH_ISSUER_URL: z
        .string()
        .url({ message: "must be a valid https:// URL" })
        .optional(),
      AUTH_AUDIENCE: z.string().min(1).optional(),
      AUTH_JWKS_URL: z.string().url({ message: "must be a valid URL" }).optional(),

      // Tier 2/3 — media pipeline gate + format-checked optionals
      MEDIA_THRESHOLDS_JSON: mediaThresholdsJson(prod).optional(),
      MEDIA_MAX_BYTES_IMAGE: positiveIntString.optional(),
      MEDIA_MAX_BYTES_VIDEO: positiveIntString.optional(),
      MEDIA_MAX_BYTES_AUDIO: positiveIntString.optional(),
      MEDIA_MAX_PIXELS: positiveIntString.optional(),
      MEDIA_RATE_UPLOAD_PER_MIN: positiveIntString.optional(),
      MEDIA_RATE_BATCH_PER_MIN: positiveIntString.optional(),
      MEDIA_RATE_SERVE_PER_MIN: positiveIntString.optional(),
      MEDIA_MAX_DURATION_SECONDS: positiveIntString.optional(),
      MEDIA_REVIEW_RATE_CAP: positiveIntString.optional(),
      // Rolling window (ms) for the review-rate cap (T15c). Optional; the
      // gate falls back to its compiled 24 h default (review-rate-cap.ts).
      MEDIA_REVIEW_RATE_WINDOW_MS: positiveIntString.optional(),
      MEDIA_QUOTA_MAX_OBJECTS: positiveIntString.optional(),
      MEDIA_QUOTA_MAX_BYTES: positiveIntString.optional(),
      MEDIA_CANONICAL_QUALITY: qualityString.optional(),
      MEDIA_CANONICAL_FORMAT: z.enum(["jpeg", "png", "webp"]).optional(),
      MEDIA_ALLOWLIST_IMAGE_JSON: jsonStringArray.optional(),
      MEDIA_ALLOWLIST_VIDEO_JSON: jsonStringArray.optional(),
      MEDIA_ALLOWLIST_AUDIO_JSON: jsonStringArray.optional(),
      MEDIA_PRESETS_JSON: jsonStringArray.optional(),

      // Feature flags: fail-closed at runtime, but "TRUE"/"yes"/"1" is operator
      // misconfig (they meant to enable it) — reject at boot.
      ACTIVITYPUB_ENABLED: z.enum(["true", "false"]).optional(),
    })
    .superRefine((env, ctx) => {
      // ── Database: one of the three accepted forms ─────────────────────────
      const hasLegacyTriple =
        env.DB_SECRET_USERNAME !== undefined &&
        env.DB_SECRET_PASSWORD !== undefined &&
        env.DB_SECRET_HOST !== undefined;
      const hasAnyLegacy =
        env.DB_SECRET_USERNAME !== undefined ||
        env.DB_SECRET_PASSWORD !== undefined ||
        env.DB_SECRET_HOST !== undefined;
      if (!env.DATABASE_URL && !env.DB_SECRET_ARN && !hasLegacyTriple) {
        ctx.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: hasAnyLegacy
            ? "database configuration incomplete — the legacy form needs all of DB_SECRET_USERNAME + DB_SECRET_PASSWORD + DB_SECRET_HOST (or set DATABASE_URL / DB_SECRET_ARN)"
            : "database configuration missing — set DATABASE_URL (local/dev), DB_SECRET_ARN (AWS Secrets Manager), or DB_SECRET_USERNAME + DB_SECRET_PASSWORD + DB_SECRET_HOST",
        });
      }

      // ── Session secret: value or ARN ──────────────────────────────────────
      if (env.SESSION_SECRET === undefined && env.SESSION_SECRET_ARN === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["SESSION_SECRET"],
          message:
            "session secret missing — set SESSION_SECRET (local/dev, at least 32 characters) or SESSION_SECRET_ARN (AWS Secrets Manager)",
        });
      }

      // ── Cognito ids (matches the S1.4 post-build checks, but at boot) ─────
      if (env.COGNITO_USER_POOL_ID === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["COGNITO_USER_POOL_ID"],
          message: "required — Cognito user pool id (JWT verification cannot start without it)",
        });
      }
      if (env.COGNITO_APP_CLIENT_ID === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["COGNITO_APP_CLIENT_ID"],
          message: "required — Cognito app client id",
        });
      }

      // ── [SEC-6] non-Cognito issuer requires an explicit audience ─────────
      // The AUTH_AUDIENCE = COGNITO_APP_CLIENT_ID default is only correct for a
      // Cognito issuer. A Keycloak/Zitadel AUTH_ISSUER_URL without AUTH_AUDIENCE
      // would silently reject every token — fail closed at boot with a clear
      // message instead. (In WS-3.1 only the Cognito path is deployed, so this
      // never fires in practice yet; it prevents a WS-3.3 footgun.)
      if (
        env.AUTH_ISSUER_URL !== undefined &&
        !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[^/]+$/.test(env.AUTH_ISSUER_URL) &&
        env.AUTH_AUDIENCE === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["AUTH_AUDIENCE"],
          message:
            "required when AUTH_ISSUER_URL is a non-Cognito issuer (the COGNITO_APP_CLIENT_ID default would reject every token)",
        });
      }

      // ── Prod-only tier (dev-only-overridable vars) ────────────────────────
      if (prod) {
        if (env.SESSION_SALT === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["SESSION_SALT"],
            message: "required in prod — session-encryption salt (optional in dev)",
          });
        }
        if (env.MEDIA_THRESHOLDS_JSON === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["MEDIA_THRESHOLDS_JSON"],
            message:
              "required in prod — the media-moderation gate thresholds (optional in dev, where absence fail-closes every category to review)",
          });
        }
      }
    });
}

/**
 * Validate the raw environment for boot. Returns a list of human-readable
 * issues, each prefixed with the offending key; empty list = valid.
 *
 * Pure: reads only the `env` argument (defaults to `process.env`), never
 * mutates anything.
 */
export function validateBootEnv(
  env: Record<string, string | undefined> = process.env,
  stage: BootStage = resolveBootStage(env),
): string[] {
  const result = buildBootEnvSchema(stage).safeParse(env);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join(".") : "(env)";
    return `${key}: ${issue.message}`;
  });
}

/** Validate and throw {@link EnvBootValidationError} on any issue. */
export function assertBootEnv(
  env: Record<string, string | undefined> = process.env,
  stage: BootStage = resolveBootStage(env),
): void {
  const issues = validateBootEnv(env, stage);
  if (issues.length > 0) {
    throw new EnvBootValidationError(issues);
  }
}
