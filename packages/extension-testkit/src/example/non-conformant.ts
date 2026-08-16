/**
 * Deliberately non-conformant extensions.
 *
 * A conformance suite that only ever runs against a conformant fixture proves
 * nothing: it would pass just as happily if every check returned `[]`. These
 * exist so the suite's own lane can assert that each check *fires*, and that
 * the finding it produces names the right problem.
 *
 * Each one is otherwise valid — core boots all of them — because the checks
 * these trip are the ones core deliberately does not enforce. That is the
 * whole reason the testkit is stricter than core.
 *
 * ONE CHECK HAS NO FIXTURE HERE: `routes-mount`. A route that is declared but
 * does not mount cannot be fabricated from the extension side — core mounts
 * what it is given. The suite covers that check's fail-closed behaviour a
 * different way, by probing an undeclared path and requiring a 404 before it
 * trusts any of its own probes. See `checkRoutesMount`.
 */

import { z } from "zod";
import { EXTENSION_API_VERSION, type TrellisExtension } from "@de-otio/trellis-extension-api";

/** The valid floor each fixture below breaks in exactly one way. */
function base(): Omit<TrellisExtension, "id"> {
  return {
    terminology: { entity: "thing", entityPlural: "things" },
    routes: [],
    metadataSchema: z.object({}).passthrough(),
  };
}

/**
 * Declares no `extensionApiVersion`.
 *
 * Core logs one warning and serves. The testkit calls it an error: an
 * undeclared extension gets no protection against a silently incompatible
 * core, which is precisely what the field is for.
 */
export const undeclaredVersionExtension: TrellisExtension = {
  ...base(),
  id: "nc-undeclared",
};

/**
 * Declares a version from a different compatibility window.
 *
 * Core also fails startup on this one, so the testkit's finding is a better
 * message rather than new coverage — worth having because it arrives from the
 * author's own test run instead of a container that would not start.
 */
export const staleVersionExtension: TrellisExtension = {
  ...base(),
  id: "nc-stale",
  extensionApiVersion: "0.1.0",
};

/**
 * Declares a cross-tenant read grant with nothing that could use it: no
 * wrapped routes, no jobs, no `extendRecap`, so nothing it ships can ever
 * obtain a context and call `discover()`.
 *
 * `post` is on core's discover allow-list, so core accepts this at boot
 * without comment — which is the point. (`entity` is NOT on that list, despite
 * being the most obvious guess; core rejects it at registration. Picking it
 * here would have made this fixture test core's allow-list instead of the
 * check under test.) It is the widest thing an extension can ask for, granted
 * to code that cannot use it — free today, and a real hole the day someone
 * adds a route.
 *
 * It declares a version so the cross-tenant finding arrives alone: a fixture
 * that trips two checks cannot tell you which one is broken. The constant
 * comes from *this* package's contract copy rather than core's, which in the
 * worst case reads as a `drift` warning — never an error, so the isolation
 * holds either way.
 */
export const deadCrossTenantGrantExtension: TrellisExtension = {
  ...base(),
  id: "nc-dead-grant",
  extensionApiVersion: EXTENSION_API_VERSION,
  crossTenantRead: ["post"],
};
