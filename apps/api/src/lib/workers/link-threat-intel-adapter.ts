/**
 * `LinkThreatIntelPort` over the existing `ThreatIntelService`.
 *
 * Lives outside the worker core so the core never sees
 * `GOOGLE_SAFE_BROWSING_API_KEY` or the KV cache (finding 7: a worker core may
 * not read secrets or `process.env`, transitively). The composition root binds
 * the env here; the core sees a URL in and a verdict out.
 *
 * `ThreatIntelService.checkSafeBrowsing` already reads and writes its own KV
 * cache, so this adds no caching of its own.
 */

import type { LinkThreatIntelPort } from "./context.js";
import {
  ThreatIntelService,
  type ThreatIntelEnv,
} from "../threat-intel-service.js";

/**
 * Only a transient failure is worth retrying. "api-key-missing" is a
 * configuration fault — redelivering the message cannot fix it, and treating it
 * as retryable would dead-letter every link on a misconfigured deployment
 * instead of recording them as unverified.
 */
const RETRYABLE_FAIL_REASONS: ReadonlySet<string> = new Set([
  "api-error",
  "api-exception",
]);

/**
 * `resolveEnv` is LAZY on purpose, matching `getAppEnv` in the container's
 * composition root: it carries the Safe Browsing API key, and the KV cache it
 * also carries is not yet constructed when the dispatch table is built.
 */
export function makeLinkThreatIntelPort(
  resolveEnv: () => ThreatIntelEnv | Promise<ThreatIntelEnv>,
  service: ThreatIntelService = new ThreatIntelService(),
): LinkThreatIntelPort {
  return {
    async check(url) {
      const env = await resolveEnv();
      const result = await service.checkSafeBrowsing(url, env);
      return {
        status: result.status,
        threats: result.threats,
        failOpenReason: result.failOpenReason,
        retryable:
          result.status === "unknown" &&
          result.failOpenReason !== undefined &&
          RETRYABLE_FAIL_REASONS.has(result.failOpenReason),
      };
    },
  };
}
