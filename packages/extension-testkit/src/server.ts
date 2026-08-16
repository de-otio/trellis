/**
 * Boot a real Trellis server, in-process, with your extension registered.
 *
 * This is the packaged form of the `globalSetup` core uses for its own
 * standalone lane, and that the first downstream vertical reproduced by hand.
 * It is a fixture, not a framework: it applies env, brings the local stack to
 * a usable state, registers, boots, and hands back a URL and a `stop()`.
 */

import type { Server } from "node:http";
import type { TrellisExtension } from "@de-otio/trellis-extension-api";
import { checkExtensionConformance, formatConformanceReport } from "./conformance.js";
import { loadCore } from "./core.js";
import { standaloneEnv, type StandaloneEnvOptions } from "./env.js";
import {
  applyCoreMigrations,
  coreSchemaPath,
  ensureDynamoTable,
  seedGlobalFeatureToggles,
  waitForHealth,
} from "./infra.js";

/**
 * Toggles core's own handlers gate on, which default to OFF. A lane that does
 * not enable them gets 403s and 404s from core that look like extension bugs.
 */
export const DEFAULT_FEATURE_TOGGLES = [
  "entity_profiles_enabled",
  "global_public_posting_enabled",
] as const;

export interface StartStandaloneServerOptions extends StandaloneEnvOptions {
  /**
   * Extensions to register, in order. Registering is what core validates at
   * boot, so a contract violation surfaces here as a thrown error.
   */
  readonly extensions: readonly TrellisExtension<any>[];
  /**
   * Run `prisma migrate deploy` against core's shipped migrations first.
   * Default `true`. Set false when something else owns the schema (a shared
   * CI database, a migration job that already ran).
   */
  readonly migrate?: boolean;
  /**
   * Path to core's `schema.prisma`. Defaults to the copy inside the installed
   * `@de-otio/trellis` tarball. Needed when core is a git checkout or a
   * workspace link, where `prisma/` is created at pack time and so is not
   * there — see {@link coreSchemaPath}.
   */
  readonly schemaPath?: string;
  /**
   * Global feature toggles to enable. Defaults to {@link DEFAULT_FEATURE_TOGGLES};
   * pass an explicit list (including `[]`) to take control.
   */
  readonly featureToggles?: readonly string[];
  /** How long to wait for `GET /health`. Default 30s. */
  readonly healthTimeoutMs?: number;
  /**
   * Run the conformance checks against every registered extension once the
   * server is healthy. Default `"assert"`.
   *
   * It runs HERE rather than being left to a test file because core's
   * extension registry is in-process state: a check run from a test worker
   * sees an empty registry and reports a registration failure that did not
   * happen. This is the one place that is always the right process.
   *
   * - `"assert"` — throw on any error-severity finding, with the full report.
   * - `"warn"` — print the report and continue. For adopting the testkit into
   *   a lane that has findings you have not fixed yet.
   * - `"off"` — skip.
   */
  readonly conformance?: "assert" | "warn" | "off";
  /** Finding slugs to downgrade to warnings; see `ConformanceOptions.accept`. */
  readonly acceptConformance?: readonly string[];
}

export interface StandaloneServer {
  /** Base URL the server is listening on, e.g. `http://localhost:3100`. */
  readonly url: string;
  /** The underlying node server, for anything this interface does not cover. */
  readonly server: Server;
  /**
   * Close the server and release core's process-wide pools. Safe to call more
   * than once, and never throws — a teardown that throws turns a passing run
   * into a red one.
   */
  stop(): Promise<void>;
}

/**
 * Start a Trellis server with `extensions` registered.
 *
 * Throws if core refuses the registration, if the stack is unreachable, or if
 * the server does not become healthy — all of which are the answers you want
 * from a test lane.
 */
export async function startStandaloneServer(
  options: StartStandaloneServerOptions,
): Promise<StandaloneServer> {
  if (options.extensions.length === 0) {
    throw new Error(
      "[testkit] startStandaloneServer() was given no extensions. Booting core " +
        "with nothing registered tests core, not your extension.",
    );
  }

  // Env FIRST, and core imported only afterwards: several core modules read
  // process.env at import time, so importing core any earlier freezes the
  // wrong values. This ordering is the reason every import below is dynamic.
  const env = standaloneEnv(options);

  if (options.migrate !== false) {
    await applyCoreMigrations({
      databaseUrl: env.databaseUrl,
      schemaPath: options.schemaPath,
    });
  }
  await ensureDynamoTable({
    table: env.dynamoTable,
    endpoint: env.dynamoEndpoint,
  });

  const core = await loadCore();
  for (const extension of options.extensions) {
    core.registerExtension(extension);
  }

  const server = await core.startServer();
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Drop idle keep-alive sockets, or close() waits on them and the runner
    // sits for ~10s before force-exiting.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await core.shutdownTrellis();
  };

  try {
    await waitForHealth(env.apiUrl, options.healthTimeoutMs ?? 30_000);
    await seedGlobalFeatureToggles(options.featureToggles ?? DEFAULT_FEATURE_TOGGLES, {
      databaseUrl: env.databaseUrl,
    });

    const mode = options.conformance ?? "assert";
    if (mode !== "off") {
      for (const extension of options.extensions) {
        const result = await checkExtensionConformance({
          extension,
          apiUrl: env.apiUrl,
          accept: options.acceptConformance,
        });
        if (result.ok) continue;
        const report =
          `[testkit] extension "${extension.id}" is not conformant.\n` +
          formatConformanceReport(result);
        if (mode === "assert") throw new Error(report);
        // eslint-disable-next-line no-console
        console.warn(report);
      }
    }
  } catch (err) {
    // A half-started server left listening would hold the port against the
    // next attempt and report the wrong cause.
    await stop();
    throw err;
  }

  return { url: env.apiUrl, server, stop };
}
