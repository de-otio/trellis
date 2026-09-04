/**
 * The reference extension — the thing an author copies, and an agent reads.
 *
 * A neutral, domain-free vertical: the terminology is deliberately generic
 * ("widget") so nothing here reads as a product decision. It is also core's
 * own dummy target — core's contract tests and standalone lane import these
 * objects — which is what keeps it honest. A reference extension that nothing
 * exercises rots into a lie about the contract.
 *
 * `exampleExtension` populates every optional surface **core actually
 * invokes**. That qualifier is the interesting part: this fixture used to also
 * declare `hooks`, `init`, `taxonomySeed`, `discoveryFacets`,
 * `entityRelationshipTypes`, `relationshipSignalProvider` and
 * `recommendationStrategy` — all declared by the contract, none ever
 * dispatched by core. Exercising them produced passing tests that proved only
 * that the fixture could call itself. They were removed along with that
 * surface, and the lesson is why the conformance suite exists.
 *
 * `minimalExtension` is the other end: every optional field omitted, including
 * `extensionApiVersion`. It is the standing proof that the contract's optional
 * fields really are optional — so please do not "fix" it by declaring things.
 */

import { z } from "zod";
import {
  EXTENSION_API_VERSION,
  type TrellisExtension,
  type ExtensionHandler,
} from "@de-otio/trellis-extension-api";

// ---------------------------------------------------------------------------
// Observable side-effects, exported so in-process contract tests can assert
// lifecycle behaviour. HTTP-level tests do not read these: they run in a
// different process from the booted server.
// ---------------------------------------------------------------------------

export interface HookCall {
  hook: string;
  args: unknown[];
}

/** Records every lifecycle invocation, in call order. */
export const hookCalls: HookCall[] = [];

function record(hook: string, ...args: unknown[]): void {
  hookCalls.push({ hook, args });
}

/** Reset recorded calls, for test isolation. */
export function resetHookCalls(): void {
  hookCalls.length = 0;
}

// ---------------------------------------------------------------------------
// Metadata schema for the "example" entity type. Core validates
// `Entity.metadata` against this when `entityType === "example"`.
// ---------------------------------------------------------------------------

export const exampleMetadataSchema = z
  .object({
    color: z.string().min(1),
    size: z.enum(["s", "m", "l"]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Core-wrapped extension routes — mounted at /api/ext/example/<path>.
// ---------------------------------------------------------------------------

const pingHandler: ExtensionHandler = async () => ({
  status: 200,
  body: { pong: true },
});

const whoamiHandler: ExtensionHandler = async (_request, _params, session) => ({
  status: 200,
  body: { userId: session?.userId ?? null, email: session?.email ?? null },
});

const echoHandler: ExtensionHandler = async (request) => {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  return { status: 200, body: { echoed: body } };
};

// ---------------------------------------------------------------------------
// The full example — every optional surface core dispatches.
// ---------------------------------------------------------------------------

export const exampleExtension: TrellisExtension = {
  id: "example",

  // Imported, never written as a literal: a rebuild then keeps it truthful on
  // its own, which is the only way this field stays worth checking.
  extensionApiVersion: EXTENSION_API_VERSION,

  terminology: {
    entity: "widget",
    entityPlural: "widgets",
  },

  // Raw routes: none. `extensionRoutes` below is the preferred surface — core
  // wraps those with auth, CSRF and error handling.
  routes: [],

  metadataSchema: exampleMetadataSchema,

  extensionRoutes: [
    {
      path: "ping",
      method: "GET",
      auth: "none",
      description: "Public liveness ping (no auth).",
      handle: pingHandler,
    },
    {
      path: "whoami",
      method: "GET",
      auth: "required",
      description: "Echoes the authenticated session (auth required).",
      handle: whoamiHandler,
    },
    {
      path: "echo",
      method: "POST",
      auth: "required",
      description: "Echoes the posted JSON body (auth required).",
      handle: echoHandler,
    },
  ],

  configSchema: z.object({
    // A single required key — boot must fail if it is unset.
    EXAMPLE_GREETING: z.string().min(1),
  }),

  activityPub: {
    enrichActor: (entity: any) => ({
      summary: `Example widget: ${entity?.name ?? "unnamed"}`,
      attachment: [
        {
          type: "PropertyValue",
          name: "Color",
          value: entity?.metadata?.color ?? "unknown",
        },
      ],
    }),
  },

  computeLifeStage: (metadata: any) => {
    // Trivial derivation: large widgets are "mature".
    if (metadata?.size === "l") return "mature";
    if (metadata?.size === "s") return "new";
    return null;
  },

  shutdown: async () => {
    record("shutdown");
  },
};

// ---------------------------------------------------------------------------
// The minimal example — only the required fields.
// ---------------------------------------------------------------------------

export const minimalExtension: TrellisExtension = {
  id: "minimal",
  terminology: {
    entity: "thing",
    entityPlural: "things",
  },
  routes: [],
  // Accept any object metadata.
  metadataSchema: z.object({}).passthrough(),
};

/** The env key `exampleExtension.configSchema` requires in order to boot. */
export const EXAMPLE_EXTENSION_ENV = {
  EXAMPLE_GREETING: "hello from the testkit",
} as const;
