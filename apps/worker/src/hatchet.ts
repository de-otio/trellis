/**
 * hatchet.ts — Hatchet SDK host (plan 030, Lane B / task B1).
 *
 * ⚠ EVALUATION SCAFFOLDING. Plan 030 decides *run the evaluation*, not *adopt
 * Hatchet*. Nothing here is load-bearing: the whole module is inert unless
 * HATCHET_ENABLED is exactly "true", and if the kill criteria fire it is
 * deleted without touching anything else.
 *
 * TWO CONSTRAINTS THIS FILE EXISTS TO HONOUR:
 *
 * 1. **Core stays SDK-free.** `@hatchet-dev/typescript-sdk` is imported HERE
 *    and nowhere else. No import of it may cross into `@de-otio/trellis`
 *    (apps/api) — that package is published, and a dependency added there is a
 *    dependency every consumer inherits for an evaluation they did not opt into.
 *
 * 2. **Opt-in, fail-closed.** Same shape as ACTIVITYPUB_ENABLED: only the exact
 *    string "true" enables it. An unset, empty, or misspelled value leaves the
 *    worker exactly as it was, and `start()` returns null rather than throwing,
 *    so a broken evaluation can never take the worker's real queues down.
 *
 * IMPORT FORM IS DELIBERATE — see doc/evaluation/hatchet-sdk-interop.md:
 *   - named import, because the DEFAULT import resolves to the CJS
 *     `module.exports` object rather than the client class;
 *   - the `/v1` subpath, because the package root re-exports the removed v0
 *     modules and emits three lines of noise on stderr at mere import, one of
 *     them a bare non-JSON line that no structured-log parser will accept;
 *   - the explicit `/index.js`, because the package ships no `exports` field,
 *     so a bare directory subpath throws ERR_UNSUPPORTED_DIR_IMPORT under ESM.
 * All three were measured, not assumed.
 */

import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";

interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

/** The trivial task B1 asks for: proves the round trip and nothing else.
 *
 *  These are `type` aliases, not `interface`s, and that is load-bearing. The
 *  SDK constrains task input/output to its `JsonObject` (an index-signature
 *  type). TypeScript gives a type alias an implicit index signature but does
 *  NOT give one to an interface, so declaring these as interfaces makes the
 *  typed `task<I, O>` overload silently unselectable — TS falls through to the
 *  inference overload and reports a confusing error about `Fn`. */
export type EchoInput = {
  message: string;
};
export type EchoOutput = {
  echoed: string;
  workerReceivedAt: string;
};

export interface HatchetHost {
  readonly worker: { start: () => Promise<void>; stop: () => Promise<void> };
}

/**
 * Start the SDK worker, or return null when the evaluation is off.
 *
 * Returns null — never throws — for every "not enabled" and "not configured"
 * path. A missing token is a misconfiguration of an OPTIONAL subsystem; making
 * it fatal would let the evaluation crash-loop the real worker.
 */
export async function startHatchetHost(logger: Logger): Promise<HatchetHost | null> {
  if (process.env.HATCHET_ENABLED !== "true") return null;

  // The SDK reads HATCHET_CLIENT_TOKEN itself. Check for presence only — never
  // read the value into a local, never log it, never include it in an error.
  if (!process.env.HATCHET_CLIENT_TOKEN) {
    logger.warn("hatchet enabled but HATCHET_CLIENT_TOKEN is unset — host not started");
    return null;
  }

  const hatchet = HatchetClient.init({
    // B3: route spans through the estate's existing OTel pipeline rather than
    // letting the SDK stand up its own collector. The peer deps are all
    // optional, so this is a runtime question, not a resolution one.
    // TODO(B3): confirm the flag name against the pinned OTel family and
    // verify no second exporter is created. Do not assume this line works
    // because it type-checks.
    // otel: { enableHatchetCollector: false },
  });

  // Explicit generics: the inference overload resolves `fn` against
  // `(input: JsonObject) => void`, which rejects a typed input. Naming I and O
  // selects the first overload and keeps EchoInput/EchoOutput real types rather
  // than widening them to JsonObject.
  const echo = hatchet.task<EchoInput, EchoOutput>({
    name: "trellis-echo",
    fn: (input: EchoInput): EchoOutput => ({
      echoed: input.message,
      workerReceivedAt: new Date().toISOString(),
    }),
  });

  const worker = await hatchet.worker("trellis-eval-worker", {
    workflows: [echo],
    // One slot. This is a liveness proof, not a throughput test, and an
    // evaluation worker must never compete for resources with the real queues.
    slots: 1,
  });

  logger.info("hatchet evaluation host started", { worker: "trellis-eval-worker", slots: 1 });
  return { worker };
}
