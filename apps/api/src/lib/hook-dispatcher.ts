/**
 * Extension Hook Dispatcher
 *
 * Dispatches lifecycle events to registered extensions with:
 * - 5-second timeout per hook (prevents hung external API calls)
 * - Circuit breaker (disables after 5 consecutive failures)
 * - Scoped context (extensions receive ExtensionContext, not Env)
 * - Fire-and-forget (hook failures never fail core operations)
 */

import type { ExtensionHooks } from "@de-otio/trellis-extension-api";
import { getExtensions } from "../extensions.js";
import { createExtensionContext } from "./extension-context.js";
import { getLogger, Logger } from "./logger.js";
import type { Env } from "../env.js";

const HOOK_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 5;

const logger = getLogger();

// Track consecutive failures per extension per hook
const failureCounts = new Map<string, number>();

/**
 * Dispatch a lifecycle hook to all registered extensions.
 *
 * Core passes env and prisma; the dispatcher creates the scoped
 * ExtensionContext internally — extensions never see raw Env.
 */
export async function dispatchHook<K extends keyof ExtensionHooks>(
  hookName: K,
  env: Env,
  prisma: any,
  ...args: any[]
): Promise<void> {
  for (const ext of getExtensions()) {
    const hook = ext.hooks?.[hookName];
    if (!hook) continue;

    const key = `${ext.id}:${String(hookName)}`;

    // Circuit breaker: skip if too many consecutive failures
    const currentFailures = failureCounts.get(key) ?? 0;
    if (currentFailures >= MAX_CONSECUTIVE_FAILURES) {
      continue;
    }

    try {
      const ctx = createExtensionContext(ext, env, prisma);
      await Promise.race([
        (hook as Function)(...args, ctx),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Hook "${String(hookName)}" timed out after ${HOOK_TIMEOUT_MS}ms`)),
            HOOK_TIMEOUT_MS,
          ),
        ),
      ]);
      // Reset on success
      failureCounts.delete(key);
    } catch (error) {
      const count = currentFailures + 1;
      failureCounts.set(key, count);
      logger.warn(
        `Extension "${ext.id}" hook "${String(hookName)}" failed (${count}/${MAX_CONSECUTIVE_FAILURES}):`,
        error,
      );
      if (count >= MAX_CONSECUTIVE_FAILURES) {
        logger.error(
          `Extension "${ext.id}" hook "${String(hookName)}" disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
        );
      }
    }
  }
}

/** Reset circuit breaker state (for testing) */
export function resetHookCircuitBreakers(): void {
  failureCounts.clear();
}
