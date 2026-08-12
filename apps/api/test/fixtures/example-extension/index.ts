/**
 * Example Extension — the generic dummy target.
 *
 * A neutral, domain-free reference vertical used by the standalone test lane
 * (see doc/02-technical/development/testing/standalone.md). It is NOT a real
 * product — terminology is deliberately generic ("widget") — and it lives
 * under test/ so it never ships in the published tarball.
 *
 * `exampleExtension` deliberately exercises EVERY optional TrellisExtension
 * surface, so a breaking change to any of them fails a standalone test here,
 * before publish. `minimalExtension` proves the contract works when every
 * optional field is omitted.
 *
 * "Every optional surface" means every surface core actually invokes. The
 * fixture used to also declare `hooks`, `init`, `taxonomySeed`,
 * `discoveryFacets`, `entityRelationshipTypes`, `relationshipSignalProvider`
 * and `recommendationStrategy` — declared by the contract, never dispatched
 * by core. Exercising them here produced passing tests that proved only that
 * the fixture can call itself. Removed with that surface.
 */

import { z } from "zod";
import type {
  TrellisExtension,
  ExtensionHandler,
} from "@de-otio/trellis-extension-api";

// ---------------------------------------------------------------------------
// Observable side-effects — exported so in-process contract tests (Stage 4)
// can assert lifecycle behaviour. HTTP-level standalone tests don't read
// these (they run in a different process from the booted server).
// ---------------------------------------------------------------------------

export interface HookCall {
  hook: string;
  args: unknown[];
}

/** Records every hook/lifecycle invocation in call order. */
export const hookCalls: HookCall[] = [];

function record(hook: string, ...args: unknown[]): void {
  hookCalls.push({ hook, args });
}

/** Reset recorded calls (for test isolation). */
export function resetHookCalls(): void {
  hookCalls.length = 0;
}

// ---------------------------------------------------------------------------
// Metadata schema for the "example" entity type. Entity create/update validates
// Entity.metadata against this when entityType === "example".
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
// The full example extension — every optional surface populated.
// ---------------------------------------------------------------------------

export const exampleExtension: TrellisExtension = {
  id: "example",

  terminology: {
    entity: "widget",
    entityPlural: "widgets",
  },

  // Raw routes: none. We use the preferred core-wrapped `extensionRoutes`.
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
        { type: "PropertyValue", name: "Color", value: entity?.metadata?.color ?? "unknown" },
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
// The minimal extension — only the required fields. Proves the contract works
// when every optional surface is omitted.
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
