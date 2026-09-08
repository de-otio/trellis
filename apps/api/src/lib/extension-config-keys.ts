/**
 * Core secret env keys — the denylist behind `ExtensionContext.config`.
 *
 * The published contract says an extension "never sees core secrets such as
 * `SESSION_SECRET`, `DATABASE_URL`, or API keys"
 * (`docs/reference/extension-api.md` § configSchema, and the doc comment on
 * `ExtensionContext` itself). Until this module existed that sentence was
 * prose: `extractExtensionConfig` handed back `process.env[key]` for *every*
 * key named in the extension's own `configSchema`, so
 * `z.object({ SESSION_SECRET: z.string() })` put the session-signing key on
 * `ctx.config`. Declaring the key was the whole exploit.
 *
 * In-process extension code can of course still read `process.env` directly —
 * extensions are unsandboxed (see `lib/app.ts`). This is not a sandbox. It is
 * the guard rail that makes the *documented* surface tell the truth, so an
 * honest-but-wrong extension cannot acquire a core secret by accident and a
 * reviewer reading the manifest can see the intent.
 *
 * Two enforcement points, deliberately:
 *  1. `validateExtensions` refuses the boot and names the keys — an extension
 *     that wants a core secret is a design problem, not a runtime one.
 *  2. `extractExtensionConfig` drops them anyway, so a context built without
 *     going through validation (tests, embedders) still cannot leak one.
 */

/**
 * Core-owned env keys an extension may never read through `ctx.config`.
 *
 * Sources, and the reason each is here:
 *  - every secret-class key declared in `env-schema.ts` (credentials, the
 *    session signing secret and salt, the at-rest KEKs);
 *  - the ambient AWS credential trio, which is not in the boot schema because
 *    core never declares it — the SDK reads it straight from the process env,
 *    which is exactly why an extension must not be able to name it.
 *
 * `test/unit/extension-config-keys.test.ts` re-derives the first group from
 * `env-schema.ts` and fails if a new secret-shaped key is added there without
 * being added here, so this list cannot silently go stale.
 */
export const CORE_SECRET_ENV_KEYS: readonly string[] = [
  // Database credentials, in all three accepted forms.
  "DATABASE_URL",
  "DB_SECRET_ARN",
  "DB_SECRET_USERNAME",
  "DB_SECRET_PASSWORD",
  "DB_SECRET_HOST",
  // Session signing / encryption.
  "SESSION_SECRET",
  "SESSION_SECRET_ARN",
  "SESSION_SALT",
  // At-rest KEKs.
  "MFA_ENC_KEY",
  "PUSH_TOKEN_ENC_KEY",
  // Identity-provider admin client.
  "IDENTITY_ADMIN_CLIENT_SECRET",
  // Ambient cloud credentials (never declared by core; read by the AWS SDK).
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

const DENIED = new Set(CORE_SECRET_ENV_KEYS);

/** True when `key` names a core secret an extension may not read. */
export function isCoreSecretEnvKey(key: string): boolean {
  return DENIED.has(key);
}

/**
 * The denied keys among `keys`, in the order given and without duplicates.
 * Returns `[]` for a clean declaration, so the caller's happy path is a
 * length check rather than a second pass.
 */
export function coreSecretEnvKeysIn(keys: Iterable<string>): string[] {
  const found: string[] = [];
  for (const key of keys) {
    if (DENIED.has(key) && !found.includes(key)) found.push(key);
  }
  return found;
}
