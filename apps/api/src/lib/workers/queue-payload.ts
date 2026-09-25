/**
 * queue-payload.ts — shared helpers for validating queue message payloads
 * (worker review W3).
 *
 * A queue message is untrusted input: anything holding the queue credential
 * can write one. Every worker core that reads fields off a payload validates
 * it against a schema first; these helpers keep the failure reporting
 * uniform and PII-free.
 */

import type { z } from "zod";
import type { Logger } from "../logger.js";
import type { WorkerDisposition } from "./disposition.js";

/**
 * Bind a schema in front of a queue worker. The wrapped worker receives the
 * PARSED payload, typed from the schema — so no binding needs an `as` cast.
 *
 * A payload that fails the schema returns `"fail"` (no-ack → redelivery →
 * DLQ), matching the dispatcher's rule for an unparseable body: a malformed
 * message is kept for inspection, never ack-dropped by inference. Only issue
 * paths are logged, never values.
 */
export function withPayloadSchema<T, Raw extends { readonly messageId: string }>(
  queueName: string,
  schema: z.ZodType<T>,
  logger: Pick<Logger, "error">,
  worker: (payload: T, raw: Raw) => Promise<WorkerDisposition | void>,
): (payload: unknown, raw: Raw) => Promise<WorkerDisposition | void> {
  return async (payload, raw) => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      logger.error("queue payload failed schema validation — leaving message in flight (no-ack)", {
        queue: queueName,
        messageId: raw.messageId,
        issues: formatIssuePaths(parsed.error),
      });
      return "fail";
    }
    return worker(parsed.data, raw);
  };
}

/**
 * Issue PATHS and codes only — never the received values. A payload that
 * fails validation is untrusted input, and its values may carry PII (the
 * export message carries an email address).
 */
export function formatIssuePaths(error: z.ZodError): string {
  return error.issues
    // String(): zod 4 paths may hold symbols, which `join` would throw on.
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>"}: ${issue.code}`)
    .join("; ");
}
