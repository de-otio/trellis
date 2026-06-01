/**
 * Standalone per-worker setupFile.
 *
 * Runs in every test worker (the server boots once in global-setup.ts, in the
 * main process). Applies the same env defaults so getApiUrl() and the
 * test-auth helpers resolve the target the server is listening on, and quiets
 * the logger.
 */

import { configureRootLogger } from "@de-otio/saas-foundation/logger";
import { applyStandaloneEnv } from "./standalone-env.js";

applyStandaloneEnv();
configureRootLogger({ level: "silent" });
