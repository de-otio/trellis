/**
 * How this package reaches `@de-otio/trellis`.
 *
 * Core is a **peer** dependency, resolved from the consumer's install at
 * runtime and never imported for its types at build time. Two independent
 * reasons, both load-bearing:
 *
 * 1. **Ordering.** Several core modules read `process.env` when they are
 *    imported, so core must be loaded only after `standaloneEnv()` has run.
 *    A static import would defeat that no matter where it appeared.
 *
 * 2. **Build order.** `npm ci` runs this package's `prepare`, and at that
 *    moment `apps/api/dist` does not exist and cannot: building it needs a
 *    generated Prisma client, which needs a database URL. A `tsc` here that
 *    resolved `@de-otio/trellis`'s declarations would make a plain `npm ci`
 *    unsatisfiable.
 *
 * So the surface is declared structurally, below. That is duplication, and
 * duplication drifts — which is why `test/core-facade.test-d.ts` asserts this
 * interface against core's real module. That check runs where core *has* been
 * built, which is the only place it could run at all.
 */

import type { Server } from "node:http";
import type { TrellisExtension } from "@de-otio/trellis-extension-api";

/** Mirror of core's `ApiVersionVerdict`. Kept structural; see the file note. */
export type CoreApiVersionVerdict =
  | { readonly kind: "absent" }
  | { readonly kind: "unparseable"; readonly raw: unknown }
  | { readonly kind: "core-unparseable"; readonly core: string }
  | {
      readonly kind: "incompatible";
      readonly declared: string;
      readonly core: string;
      readonly reason: string;
    }
  | { readonly kind: "drift"; readonly declared: string; readonly core: string }
  | { readonly kind: "match" };

/**
 * The lowest `@de-otio/trellis` that exports everything {@link CoreModule}
 * names.
 *
 * Three of those members — `shutdownTrellis`, `classifyApiVersion` and the
 * `EXTENSION_API_VERSION` re-export — landed together with this package, so the
 * first release carrying them is one that does not exist yet.
 *
 * **This is deliberately stricter than the `peerDependencies` range, and the
 * two must not be "reconciled".** A peer range may only name a version that is
 * actually published: npm resolves it against the registry, and a range whose
 * floor has no matching version fails `npm ci` with `ETARGET` — including in
 * this repo, where the workspace link does not spare it. So the range names the
 * newest published core, and this names the real requirement. {@link
 * assertCoreShape} is what enforces it, at load time, where the module can be
 * inspected instead of trusted.
 *
 * Bump this only when the requirement genuinely changes. It stays ahead of the
 * range until the release that ships these members, and then stops being ahead
 * on its own.
 */
export const MINIMUM_CORE_VERSION = "0.25.0-alpha.8";

/** The subset of `@de-otio/trellis`'s public API this package uses. */
export interface CoreModule {
  registerExtension(extension: TrellisExtension<any>): void;
  getExtension(id: string): TrellisExtension<any> | undefined;
  getExtensions(): readonly TrellisExtension<any>[];
  startServer(): Promise<Server>;
  shutdownTrellis(): Promise<{
    closed: string[];
    failed: { subsystem: string; error: unknown }[];
  }>;
  classifyApiVersion(declared: unknown, core: string): CoreApiVersionVerdict;
  readonly EXTENSION_API_VERSION: string;
}

/** The members {@link assertCoreShape} requires, and how each must look. */
const REQUIRED_CORE_MEMBERS: readonly (readonly [keyof CoreModule, "function" | "string"])[] = [
  ["registerExtension", "function"],
  ["getExtension", "function"],
  ["getExtensions", "function"],
  ["startServer", "function"],
  ["shutdownTrellis", "function"],
  ["classifyApiVersion", "function"],
  ["EXTENSION_API_VERSION", "string"],
];

/**
 * Check that a loaded module really is the core this package needs, and say
 * what is missing when it is not.
 *
 * The cast in {@link loadCore} is unchecked by construction — core's types are
 * deliberately not resolved at build time — so nothing else stands between a
 * too-old core and a `TypeError` thrown from the middle of a conformance run.
 * Semver alone will not do it either: the peer range is advisory the moment a
 * consumer links a local build, which is exactly what an extension author
 * developing against core does.
 *
 * Exported so it can be tested against a stub; {@link loadCore} applies it.
 */
export function assertCoreShape(mod: unknown): CoreModule {
  const candidate = mod as Record<string, unknown> | null | undefined;
  const missing = REQUIRED_CORE_MEMBERS.filter(
    ([name, kind]) => typeof candidate?.[name as string] !== kind,
  ).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `[testkit] the installed @de-otio/trellis does not export: ${missing.join(", ")}. ` +
        `This package needs @de-otio/trellis >= ${MINIMUM_CORE_VERSION}; ` +
        `you likely have an older one. ` +
        `(Found version: ${describeVersion(candidate)}.)`,
    );
  }
  return mod as CoreModule;
}

/** Best-effort version for the error above; core need not export one. */
function describeVersion(candidate: Record<string, unknown> | null | undefined): string {
  const version = candidate?.["VERSION"] ?? candidate?.["version"];
  return typeof version === "string" ? version : "unknown";
}

/**
 * Load `@de-otio/trellis` from the consumer's install.
 *
 * The specifier is held in a variable so TypeScript treats this as a dynamic
 * import of an unknown module rather than resolving `@de-otio/trellis`'s types
 * at build time — which is the whole point (see the file note).
 */
export async function loadCore(): Promise<CoreModule> {
  const specifier = "@de-otio/trellis";
  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch (err) {
    throw new Error(
      "[testkit] could not load @de-otio/trellis. It is a peer dependency of " +
        "this package — install it alongside the testkit. " +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return assertCoreShape(mod);
}
