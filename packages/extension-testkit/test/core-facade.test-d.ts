/**
 * The façade in `src/core.ts` must match core's real public API.
 *
 * `src/core.ts` re-declares the slice of `@de-otio/trellis` this package uses,
 * because a `tsc` here cannot resolve core's declarations — see the long note
 * in that file. Re-declaration drifts, so this is the compensating check, and
 * it lives in `test/` for the same reason: this config CAN resolve core,
 * because it only ever runs after `apps/api` has been built.
 *
 * Checked by `npm run test:types`, not by vitest — there is nothing to execute.
 * A failure here reads as a normal assignability error naming the member that
 * moved.
 */

import type * as core from "@de-otio/trellis";
import type { CoreModule } from "../src/core.js";

// The real module must satisfy the façade. This is the direction that matters:
// if core removes or narrows something the testkit calls, this fails. (The
// reverse — core having members the façade omits — is expected and fine.)
const _realSatisfiesFacade: CoreModule = null as unknown as typeof core;
void _realSatisfiesFacade;

// And the verdict union must line up in both directions, since the conformance
// suite switches on `kind` exhaustively: a new variant in core that the façade
// lacks would make that switch silently non-exhaustive.
type CoreVerdict = ReturnType<typeof core.classifyApiVersion>;
type FacadeVerdict = ReturnType<CoreModule["classifyApiVersion"]>;

const _coreKindsCovered: FacadeVerdict["kind"] = null as unknown as CoreVerdict["kind"];
const _facadeKindsReal: CoreVerdict["kind"] = null as unknown as FacadeVerdict["kind"];
void _coreKindsCovered;
void _facadeKindsReal;
