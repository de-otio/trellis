/**
 * Shared boot for this lane.
 *
 * The server is started INSIDE the test worker, not in a vitest `globalSetup`,
 * and that is the whole point rather than a convenience. Core's extension
 * registry is in-process state: a `globalSetup` boot lives in the main vitest
 * process while test files run in workers, so `getExtension()` from a test
 * would answer "nothing registered" and every registration assertion below
 * would be testing the process boundary instead of the extension.
 *
 * That constraint is real for authors too — it is why `startStandaloneServer()`
 * runs the conformance checks itself — so this lane arranges to hit it rather
 * than around it.
 *
 * One boot per file, memoised per module graph. `fileParallelism` is off and
 * there is one worker, so the files run in sequence and never contend for the
 * port.
 */

import { startStandaloneServer, type StandaloneServer } from "../src/index.js";
import { EXAMPLE_EXTENSION_ENV, exampleExtension, minimalExtension } from "../src/example/index.js";
import {
  deadCrossTenantGrantExtension,
  undeclaredVersionExtension,
} from "../src/example/non-conformant.js";
import { fileURLToPath } from "node:url";

/**
 * Core is a workspace link here, and `apps/api/prisma/` is produced by its
 * `prepack` — so the default lookup inside an installed tarball finds nothing.
 * Point at the repo's own schema, which is the same escape hatch an author
 * gets when they develop against a checkout of core. Using it here means the
 * option is exercised rather than merely documented.
 */
export const REPO_SCHEMA_PATH = fileURLToPath(
  new URL("../../../prisma/schema.prisma", import.meta.url),
);

/**
 * Everything core is willing to boot.
 *
 * `staleVersionExtension` is absent by necessity: core fails startup on an
 * incompatible declared version, so registering it would take the lane down
 * instead of producing a finding. It is checked without being registered.
 */
export const LANE_EXTENSIONS = [
  exampleExtension,
  minimalExtension,
  undeclaredVersionExtension,
  deadCrossTenantGrantExtension,
];

let booted: Promise<StandaloneServer> | undefined;

/**
 * Boot once per process.
 *
 * `conformance: "off"` — the non-conformant fixtures are registered here on
 * purpose, so the default assert would (correctly) refuse to boot. The checks
 * are then driven explicitly by the tests. `standalone-server.test.ts` covers
 * the default in the other direction.
 */
export function harness(): Promise<StandaloneServer> {
  booted ??= startStandaloneServer({
    extensions: LANE_EXTENSIONS,
    port: 3300,
    dynamoTable: "trellis-testkit-lane",
    extra: EXAMPLE_EXTENSION_ENV,
    schemaPath: REPO_SCHEMA_PATH,
    conformance: "off",
  });
  return booted;
}

/**
 * Release the port and core's pools between files.
 *
 * Deliberately NOT `process.exit()`: core's AWS SDK clients hold idle
 * keep-alive sockets with no dispose hook, and the usual fix is for a
 * `globalSetup` teardown to exit the process — but this lane has no
 * globalSetup, and a library that kills the process is not one you can call
 * from a test file. vitest tears the worker down instead.
 */
export async function stopHarness(): Promise<void> {
  const server = await booted;
  booted = undefined;
  await server?.stop();
}
