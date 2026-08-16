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

/**
 * Load `@de-otio/trellis` from the consumer's install.
 *
 * The specifier is held in a variable so TypeScript treats this as a dynamic
 * import of an unknown module rather than resolving `@de-otio/trellis`'s types
 * at build time — which is the whole point (see the file note).
 */
export async function loadCore(): Promise<CoreModule> {
  const specifier = "@de-otio/trellis";
  try {
    return (await import(specifier)) as unknown as CoreModule;
  } catch (err) {
    throw new Error(
      "[testkit] could not load @de-otio/trellis. It is a peer dependency of " +
        "this package — install it alongside the testkit. " +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
