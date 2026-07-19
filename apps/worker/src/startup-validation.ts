/**
 * startup-validation.ts — fail-closed startup secret validation
 * (WS-2 T7a, finding 2, §3.1).
 *
 * The container MUST NOT start its pollers until every secret a hosted
 * worker requires is present and NON-EMPTY. At minimum: the DB secret and —
 * because the container hosts delete-account + nightly — the pseudonym
 * tombstone HMAC key. An empty pseudonym key would silently produce
 * REVERSIBLE GDPR tombstones (`HMAC("", …)`), so the container refuses to
 * start (exit non-zero → orchestrator crash-loop → alarm).
 *
 * Blast-radius note (finding 4): each secret is resolved ONCE to prove it is
 * present, then DISCARDED — this module never retains a value, and nothing
 * here places a secret on any worker context. The delete-account/nightly
 * workers re-resolve lazily at use (and re-assert non-empty per message,
 * because a secret can rotate to empty after startup).
 */

import type { Logger } from "../../api/src/lib/logger.js";

export interface SecretRequirement {
  /** Human-readable name for logs (NEVER the value). */
  readonly name: string;
  /** Resolver. Must yield a non-empty string for validation to pass. */
  readonly resolve: () => Promise<string>;
}

export class StartupValidationError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(
      `startup validation failed — refusing to start (fail-closed): ${failures.join("; ")}`,
    );
    this.name = "StartupValidationError";
  }
}

/**
 * Resolve every requirement; throw {@link StartupValidationError} when any
 * resolves empty or errors. Returns nothing — resolved values are discarded.
 */
export async function validateRequiredSecrets(
  requirements: readonly SecretRequirement[],
  logger: Logger,
): Promise<void> {
  const failures: string[] = [];
  for (const req of requirements) {
    try {
      const value = await req.resolve();
      if (typeof value !== "string" || value.length === 0) {
        failures.push(`${req.name}: resolved empty`);
      }
      // Value intentionally dropped here — presence proven, nothing retained.
    } catch (err) {
      failures.push(`${req.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    logger.error("startup secret validation failed — container will not start", {
      failures,
    });
    throw new StartupValidationError(failures);
  }
  logger.info("startup secret validation passed", {
    validated: requirements.map((r) => r.name),
  });
}
