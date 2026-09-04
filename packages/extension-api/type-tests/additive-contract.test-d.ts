/**
 * Type-level proof that `0.10.0` is additive.
 *
 * The whole justification for landing the scoped-surface fields as one inert
 * bump is that an extension written against `0.9.2` keeps compiling unchanged.
 * That claim is worth exactly as much as the test that holds it, so §1 below
 * is a complete extension declared the way `0.9.2` allowed — no new field
 * mentioned anywhere — and it must satisfy `TrellisExtension` as written.
 *
 * Checked by `tsc --noEmit -p tsconfig.type-tests.json`, not by vitest: a type
 * assertion inside a vitest file is a runtime no-op and would never be
 * compiled. Negative cases are `@ts-expect-error`, which fails closed — if the
 * error stops occurring, tsc reports the directive as unused and this file
 * fails to build.
 *
 * Imports go through the PACKAGE NAME so the assertions run against the built
 * declarations and the `exports` map, the same path an extension author takes.
 */

import { z } from "zod";
import type {
  ExtensionEventDeclaration,
  ExtensionEventEmitter,
  ExtensionResponse,
  ExtensionRouteDefinition,
  ExtensionScopeDeclaration,
  ExtensionSession,
  TrellisExtension,
} from "@de-otio/trellis-extension-api";

/** Compile-time assertion that two types are mutually assignable. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
declare function expectType<T extends true>(): void;

/**
 * True when `K` may be omitted from `T`. `Pick` keeps the optionality marker,
 * so `{}` is assignable to the picked type exactly when the key is optional —
 * which `keyof` alone cannot tell you.
 */
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;

// ---------------------------------------------------------------------------
// 1. An extension frozen at the 0.9.2 surface still satisfies the contract
// ---------------------------------------------------------------------------

/**
 * Deliberately verbose: this is the artefact under test, not a fixture. It
 * names every field a `0.9.2` extension could carry and none that `0.10.0`
 * added. If a later change makes any added field required, or narrows an
 * existing one, this stops compiling — which is the entire point.
 */
const extensionFrozenAt_0_9_2: TrellisExtension = {
  id: "widget",
  extensionApiVersion: "0.9.2",
  terminology: { entity: "widget", entityPlural: "widgets" },
  routes: [],
  metadataSchema: z.object({ colour: z.string() }),
  crossTenantRead: ["entity"],
  extensionRoutes: [
    {
      path: "/ping",
      method: "GET",
      auth: "required",
      description: "Liveness probe",
      async handle(): Promise<ExtensionResponse> {
        return { status: 200, body: { pong: true } };
      },
    },
  ],
  jobs: [
    {
      id: "sweep",
      schedule: "daily",
      crossTenantRead: ["extWidget"],
      async run(jobCtx) {
        if (jobCtx.signal.aborted) return;
      },
    },
  ],
  configSchema: z.object({ WIDGET_API_URL: z.string() }),
  activityPub: { enrichActor: () => ({ summary: "a widget" }) },
  computeLifeStage: () => null,
  async extendRecap() {
    return { widgetsMade: 3 };
  },
  async shutdown() {},
};

void extensionFrozenAt_0_9_2;

/**
 * The same claim at the member level, so a failure names the field rather
 * than the whole object literal: nothing added in `0.10.0` may be required.
 */
expectType<IsOptional<TrellisExtension, "scopes">>();
expectType<IsOptional<TrellisExtension, "events">>();

// A `0.9.2` route definition, likewise, must still be a complete one.
const routeFrozenAt_0_9_2: ExtensionRouteDefinition = {
  path: "/widgets/:id",
  method: ["GET", "HEAD"],
  async handle(): Promise<ExtensionResponse> {
    return { status: 200, body: {} };
  },
};
void routeFrozenAt_0_9_2;

expectType<IsOptional<ExtensionRouteDefinition, "scopes">>();
expectType<IsOptional<ExtensionRouteDefinition, "publicSpec">>();
expectType<IsOptional<ExtensionRouteDefinition, "requestSchema">>();
expectType<IsOptional<ExtensionRouteDefinition, "responseSchema">>();
expectType<IsOptional<ExtensionRouteDefinition, "idempotent">>();
expectType<IsOptional<ExtensionRouteDefinition, "operationId">>();
expectType<IsOptional<ExtensionRouteDefinition, "stability">>();
expectType<IsOptional<ExtensionSession, "clientId">>();
expectType<IsOptional<ExtensionSession, "scopes">>();

// A session core built before scopes existed is still an `ExtensionSession`.
const sessionFrozenAt_0_9_2: ExtensionSession = {
  userId: "usr_1",
  email: "someone@example.com",
  role: "END_USER",
};
void sessionFrozenAt_0_9_2;

// ---------------------------------------------------------------------------
// 2. The added fields accept what the contract says they accept
// ---------------------------------------------------------------------------

const extensionUsingEverythingNew: TrellisExtension = {
  id: "widget",
  terminology: { entity: "widget", entityPlural: "widgets" },
  routes: [],
  metadataSchema: z.object({}),
  scopes: [
    { id: "widgets:read", description: "Read your widgets" },
    { id: "widgets:write", description: "Create and update your widgets" },
  ],
  events: [{ type: "widget.created", payloadSchema: z.object({ widgetId: z.string() }) }],
  extensionRoutes: [
    {
      path: "/widgets",
      method: "POST",
      scopes: ["widgets:write"],
      publicSpec: true,
      requestSchema: z.object({ colour: z.string() }),
      responseSchema: z.object({ id: z.string() }),
      idempotent: true,
      operationId: "createWidget",
      stability: "beta",
      async handle(_request, _params, session, ctx): Promise<ExtensionResponse> {
        // The emitter is optional in this version; an unguarded call would
        // throw at runtime, so the type has to make that visible here.
        await ctx.events?.emit("widget.created", { widgetId: "w_1" });
        void session?.clientId;
        void session?.scopes;
        return { status: 201, body: { id: "w_1" } };
      },
    },
  ],
};
void extensionUsingEverythingNew;

// The declaration types are the same shapes, reachable by name.
expectType<Equals<TrellisExtension["scopes"], ExtensionScopeDeclaration[] | undefined>>();
expectType<Equals<TrellisExtension["events"], ExtensionEventDeclaration[] | undefined>>();

expectType<Equals<ReturnType<ExtensionEventEmitter["emit"]>, Promise<void>>>();
expectType<Equals<Parameters<ExtensionEventEmitter["emit"]>, [string, unknown]>>();

// `scopes: []` is a distinct, expressible state from an absent `scopes`:
// "any authenticated caller" versus "first-party only".
const anyAuthenticatedCaller: ExtensionRouteDefinition = {
  path: "/whoami",
  method: "GET",
  scopes: [],
  async handle(): Promise<ExtensionResponse> {
    return { status: 200, body: {} };
  },
};
void anyAuthenticatedCaller;

// ---------------------------------------------------------------------------
// 3. Negative cases — the added fields are typed, not `any`
// ---------------------------------------------------------------------------

const badStability: ExtensionRouteDefinition = {
  path: "/x",
  method: "GET",
  // @ts-expect-error "experimental" is not one of the two stability levels.
  stability: "experimental",
  async handle(): Promise<ExtensionResponse> {
    return { status: 200, body: {} };
  },
};
void badStability;

const badScopeShape: TrellisExtension = {
  id: "widget",
  terminology: { entity: "widget", entityPlural: "widgets" },
  routes: [],
  metadataSchema: z.object({}),
  // @ts-expect-error consent copy is not optional — a scope with no
  // description cannot be shown on a consent screen.
  scopes: [{ id: "widgets:read" }],
};
void badScopeShape;

const badSessionScopes: ExtensionSession = {
  userId: "usr_1",
  email: "someone@example.com",
  role: "END_USER",
  // @ts-expect-error a plain array is not a ScopeSet; it is a set or "*".
  scopes: ["widgets:read"],
};
void badSessionScopes;
