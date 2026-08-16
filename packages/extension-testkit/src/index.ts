/**
 * @de-otio/trellis-extension-testkit
 *
 * Boot a real Trellis server against your extension, and check that it
 * conforms. See README.md.
 *
 * The reference extension is a separate entry point
 * (`@de-otio/trellis-extension-testkit/example`) so importing the harness does
 * not drag a fixture into your bundle, and so the fixture can be read on its
 * own as the thing you copy.
 */

export {
  startStandaloneServer,
  DEFAULT_FEATURE_TOGGLES,
  type StartStandaloneServerOptions,
  type StandaloneServer,
} from "./server.js";

export {
  standaloneEnv,
  DEFAULT_DATABASE_URL,
  type StandaloneEnvOptions,
  type ResolvedStandaloneEnv,
} from "./env.js";

export {
  applyCoreMigrations,
  coreSchemaPath,
  ensureDynamoTable,
  seedGlobalFeatureToggles,
  waitForHealth,
} from "./infra.js";

export {
  assertExtensionConformance,
  checkExtensionConformance,
  formatConformanceReport,
  type ConformanceFinding,
  type ConformanceOptions,
  type ConformanceResult,
  type ConformanceSeverity,
} from "./conformance.js";

export {
  loadCore,
  assertCoreShape,
  MINIMUM_CORE_VERSION,
  type CoreModule,
  type CoreApiVersionVerdict,
} from "./core.js";
