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
 */

import type { Server } from "node:http";
import { registerExtension } from "../../../src/extensions.js";
import { startServer } from "../../../src/server.js";
import { exampleExtension, minimalExtension } from "./index.js";

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
