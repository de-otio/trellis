/**
 * Standalone boot harness.
 *
 * Registers the dummy-target extensions and starts the real Trellis HTTP
 * server in-process against local infrastructure. Used by the standalone
 * vitest globalSetup — NOT shipped (lives under test/).
 *
 * Environment must already be configured by the caller (global-setup.ts)
 * before this runs: DATABASE_URL, DYNAMODB_ENDPOINT/TABLE, SESSION_SECRET,
 * COGNITO_* (dummy), EXAMPLE_GREETING, etc.
 *
 * This deliberately does NOT use the testkit's `startStandaloneServer()`,
 * even though that is the packaged form of exactly this. The testkit resolves
 * `@de-otio/trellis` — which in this workspace is `apps/api/dist` — and core's
 * own lane must boot from `src`, or it becomes a test of the last build rather
 * than of the working tree, and stops being a pre-publish gate. The testkit's
 * own lane covers the packaged path; this one covers the source.
 *
 * The extensions themselves DO come from the testkit, so there is one
 * reference extension rather than two that drift.
 */

import type { Server } from "node:http";
import { registerExtension } from "../../../src/extensions.js";
import { startServer } from "../../../src/server.js";
import { exampleExtension, minimalExtension } from "@de-otio/trellis-extension-testkit/example";

let started = false;

/**
 * Register the dummy extensions and start the server. Idempotent within a
 * process: registering twice would duplicate-fail validation, so guard it.
 */
export async function bootStandaloneServer(): Promise<Server> {
  if (started) {
    throw new Error("bootStandaloneServer() called twice in one process");
  }
  started = true;

  registerExtension(exampleExtension);
  registerExtension(minimalExtension);

  return startServer();
}
