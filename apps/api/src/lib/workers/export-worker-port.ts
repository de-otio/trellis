/**
 * ExportWorkerPort — the user-export boundary (WS-2 T11, §1.7, finding 9 —
 * Option B).
 *
 * Trellis PRODUCES to the export queue (`user-export-handler.ts`) but ships
 * NO consumer: the concrete export worker embodies the full user-data-export
 * (GDPR Art. 20 / DSAR) schema — every table and field a user's PII spans —
 * and publishing that into the public `@de-otio/trellis` tarball would
 * disclose the complete PII-export surface (a roadmap for data
 * exfiltration). So the PUBLIC tree carries only THIS interface; the
 * schema-bearing implementation lives in the private consuming package and
 * is injected into the worker runtime at startup — exactly the
 * `setMediaProcessingDeps` seam the media workers use.
 *
 * INFORMATION-CONTENT RULE (finding 9 — reviewer-gated): this file must
 * never name a table, column, or field of the export. The payload is the
 * queue message AS PRODUCED (an opaque job pointer + delivery routing); the
 * result is a disposition, nothing more. Do not widen either shape with
 * schema-revealing structure.
 */

/**
 * The queue message trellis produces (`user-export-handler.ts` — a job
 * POINTER, not the export content): the job id resolves all further state
 * from the job store; the remaining fields are delivery routing only.
 */
export interface ExportJobMessage {
  readonly jobId: string;
  readonly userId: string;
  readonly email: string;
  /** Requested delivery format (e.g. "json"). Opaque to the runtime. */
  readonly format: string;
  readonly region: string;
}

/** Terminal disposition of one export job run. */
export type ExportRunResult =
  | { readonly kind: "completed" }
  /** Permanent failure — ack-drop (the job store carries the failure state). */
  | { readonly kind: "failed"; readonly reason: string }
  /** Transient failure — no-ack; the message redelivers. */
  | { readonly kind: "retry"; readonly reason: string };

/**
 * The injected consumer. The worker runtime owns polling/dispatch/ack
 * machinery and calls `run` per message; the implementation owns everything
 * else (schema, assembly, delivery, job-store transitions) privately.
 */
export interface ExportWorkerPort {
  run(message: ExportJobMessage): Promise<ExportRunResult>;
}
