/**
 * workers.ts — the queue-name → worker dispatch table (WS-2 T7a).
 *
 * Each queue binds an extracted `lib/workers/*` core into a `MessageWorker`
 * with the NARROW capability bag that worker needs — the secret-blast-radius
 * rule (finding 4) is ENFORCED here, not just documented:
 *
 *  - the media workers' capability bag must NEVER carry the pseudonym-secret
 *    provider, an identity-admin port, or any session secret. A runtime
 *    guard throws at table-construction time if a forbidden key sneaks in.
 *  - the GDPR-bearing capabilities (pseudonym secret, identity admin) exist
 *    ONLY in the delete-account bag, and only as LAZY providers resolved at
 *    the moment of use inside the worker (§3.1a mitigation 1).
 *
 * Disposition mapping (§3.3): the media cores' RecordOutcome values surface
 * as RETURNED dispositions — their poison→REVIEW+ack path becomes
 * `"ack-drop"`, transient `"fail"` stays `"fail"`. The stub workers throw
 * (→ fail via the dispatcher's throw-is-always-fail rule). Nothing here
 * converts a throw into an ack.
 */

import type { PrismaClient } from "@prisma/client";
import type { Logger } from "../../api/src/lib/logger.js";
import type { StagingCleanupResult } from "../../api/src/lib/media/staging-object-cleanup.js";
import type { IdentityAdminPort } from "../../api/src/lib/workers/identity-admin-port.js";
import { runDeleteAccount, type DeleteAccountPayload } from "../../api/src/lib/workers/delete-account.js";
import { runLinkCheck } from "../../api/src/lib/workers/link-check.js";
import { runFollowersEvents } from "../../api/src/lib/workers/followers-events.js";
import { runFederationOutbox } from "../../api/src/lib/workers/federation-outbox.js";
import {
  getInjectedMediaProcessingDeps,
  processRecord,
} from "../../api/src/lib/workers/media-processing.js";
import {
  processCompletion,
  type CompletionDeps,
} from "../../api/src/lib/workers/media-completion.js";
import type {
  ExportJobMessage,
  ExportWorkerPort,
} from "../../api/src/lib/workers/export-worker-port.js";
import type { MessageWorker } from "./dispatch.js";

/** The queues this runtime consumes (§0 handler table + the T11 export
 *  boundary — trellis produces to user-export; the consumer is injected). */
export type WorkerQueueName =
  | "delete-account"
  | "media-processing"
  | "media-completion"
  | "link-check"
  | "followers-events"
  | "federation-outbox"
  | "user-export";

/** Capabilities for the delete-account worker — the ONLY bag allowed to
 *  carry GDPR/identity capabilities, and only as lazy providers. */
export interface DeleteAccountCapabilities {
  readonly getDb: () => Promise<PrismaClient>;
  /** LAZY — resolved inside the worker at use; never eagerly resolved. */
  readonly resolvePseudonymSecret: () => Promise<string>;
  readonly deleteStagingObjects: (keys: string[]) => Promise<StagingCleanupResult>;
  readonly identity?: IdentityAdminPort;
}

/**
 * Capabilities for the media workers. DELIBERATELY narrow — see the
 * finding-4 guard below. Media deps themselves arrive via
 * `setMediaProcessingDeps()` (processing) and this bag (completion).
 */
export interface MediaCapabilities {
  /** Completion deps; absent ⇒ the completion worker fails closed (throws). */
  readonly completionDeps?: CompletionDeps;
}

/** Keys that must NEVER appear in the media capability bag (finding 4). */
export const FORBIDDEN_MEDIA_CAPABILITY_KEYS: readonly string[] = [
  "resolvePseudonymSecret",
  "pseudonymSecret",
  "identity",
  "sessionSecret",
  "getSessionSecret",
];

export interface DispatchTableInput {
  readonly logger: Logger;
  readonly deleteAccount: DeleteAccountCapabilities;
  readonly media: MediaCapabilities;
  /**
   * T11 (finding 9): the PII-schema-bearing export worker, injected from the
   * PRIVATE consuming package. Absent ⇒ the user-export queue fails closed
   * (throw → no-ack) — export requests are never silently dropped.
   */
  readonly exportWorker?: ExportWorkerPort;
  /** Resolved by the composition root (ACTIVITYPUB_ENABLED === "true"). */
  readonly federationEnabled: boolean;
}

export function buildDispatchTable(
  input: DispatchTableInput,
): Record<WorkerQueueName, MessageWorker> {
  // FINDING 4 GUARD: refuse a media bag that carries GDPR/identity/session
  // capabilities. This is a hard construction-time failure, not a lint.
  for (const key of Object.keys(input.media)) {
    if (FORBIDDEN_MEDIA_CAPABILITY_KEYS.includes(key)) {
      throw new Error(
        `media capability bag must not carry '${key}' (secret blast radius, finding 4)`,
      );
    }
  }

  const { logger } = input;

  return {
    "delete-account": async (payload) => {
      const db = await input.deleteAccount.getDb();
      await runDeleteAccount(payload as DeleteAccountPayload, {
        db,
        logger,
        identity: input.deleteAccount.identity,
        resolvePseudonymSecret: input.deleteAccount.resolvePseudonymSecret,
        deleteStagingObjects: input.deleteAccount.deleteStagingObjects,
      });
      // void return ⇒ ack; a throw propagates ⇒ fail (dispatcher rule).
    },

    "media-processing": async (_payload, raw) => {
      const deps = getInjectedMediaProcessingDeps();
      if (deps === undefined) {
        // Fail closed exactly like the Lambda entrypoint: an un-wired worker
        // must never ack-drop real uploads. Throw ⇒ fail ⇒ redeliver.
        throw new Error("media-processing: deps not injected (setMediaProcessingDeps)");
      }
      const outcome = await processRecord(
        { body: raw.body, messageId: raw.messageId },
        deps,
      );
      if (outcome.disposition === "fail") return "fail";
      // Poison (→ REVIEW) surfaces as an EXPLICIT returned ack-drop (§3.3);
      // plain success is an ack.
      return outcome.poison === true ? "ack-drop" : "ack";
    },

    "media-completion": async (_payload, raw) => {
      const deps = input.media.completionDeps;
      if (deps === undefined) {
        // Fail closed: no completion backend wired (WS-5 decides the
        // Scaleway producer; AWS parity hosting still requires deps).
        throw new Error("media-completion: deps not injected");
      }
      const outcome = await processCompletion(raw.body, deps);
      switch (outcome.kind) {
        case "retry":
          return "fail";
        case "applied":
          return "ack";
        case "duplicate":
        case "unroutable":
        case "illegal-transition":
          // Fail-closed ack-drops — must never DLQ-loop (§1.3).
          return "ack-drop";
      }
    },

    "link-check": async (payload) => {
      await runLinkCheck(payload, { logger });
    },

    "followers-events": async (payload) => {
      await runFollowersEvents(payload, { logger });
    },

    "federation-outbox": async (payload) => {
      await runFederationOutbox(payload, {
        logger,
        federationEnabled: input.federationEnabled,
      });
      // OFF-branch returns ⇒ ack (log-and-drop); ON-branch throws ⇒ fail.
    },

    "user-export": async (payload) => {
      const port = input.exportWorker;
      if (port === undefined) {
        // Fail closed: an un-wired export consumer must never drop a DSAR
        // request. Throw ⇒ no-ack ⇒ redeliver ⇒ DLQ pages.
        throw new Error("user-export: ExportWorkerPort not injected");
      }
      const result = await port.run(payload as ExportJobMessage);
      switch (result.kind) {
        case "completed":
          return "ack";
        case "failed":
          // Permanent — the job store carries the failure; no DLQ loop.
          logger.warn("user-export: job failed permanently — ack-drop", {
            reason: result.reason,
          });
          return "ack-drop";
        case "retry":
          return "fail";
      }
    },
  };
}
