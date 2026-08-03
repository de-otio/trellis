// Imperative shell for the per-tenant disclosure posture (AI Act Art. 50, D15).
//
// One function, called at every write boundary that accepts an author
// declaration (post create, comment create). The pure decision lives in
// ./posture.ts; this file only does the tenant read and maps a rejection onto an
// HTTP response.
//
// Kept out of the handlers because there are two of them and there will be more
// (comment replies, and the generation feature if D13 is ever revisited). Two
// copies of a policy gate is how one of them ends up a version behind.

import {
  DEFAULT_DISCLOSURE_POSTURE,
  declarationRequirement,
  resolveDisclosurePosture,
  validateDeclaration,
  type DeclarationRequirement,
  type DisclosurePosture,
} from "./posture.js";

/** The narrowest DB shape this needs — a tenant `findUnique` that may return null. */
interface TenantPostureReader {
  tenant: {
    findUnique(args: {
      where: { id: string };
      select: { disclosurePosture: true };
    }): Promise<{ disclosurePosture: DisclosurePosture | null } | null>;
  };
}

const MESSAGES: Record<string, string> = {
  DECLARATION_REQUIRED:
    "This organisation requires every post to declare whether AI was used to create its content.",
  DECLARATION_MAY_NOT_BE_UNKNOWN:
    "This organisation does not accept an undeclared answer; state whether AI was used.",
};

/**
 * Read the tenant's effective posture.
 *
 * **Fail-open.** A missing tenant row or a read error resolves to the platform
 * default rather than throwing: posture governs whether we *ask* for a
 * declaration, so a policy-lookup blip must not fail the write. Failing closed on
 * the label is a different concern, handled by max-disclosure resolution in
 * `resolveProvenance`, which no posture can override.
 */
export async function readDisclosurePosture(
  db: TenantPostureReader,
  tenantId: string,
  platformDefault: DisclosurePosture = DEFAULT_DISCLOSURE_POSTURE,
): Promise<DisclosurePosture> {
  try {
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { disclosurePosture: true },
    });
    return resolveDisclosurePosture(tenant, platformDefault);
  } catch {
    return platformDefault;
  }
}

/**
 * Gate an author's declaration against the tenant's posture.
 *
 * Returns a 400 `Response` when the posture refuses the declaration, or `null`
 * when the write may proceed. `declared` is `undefined` when the request omitted
 * the field entirely — distinct from an explicit `"UNKNOWN"`, which is why the two
 * rejections carry different codes.
 *
 * COST, stated honestly: the short-circuit below skips the tenant read when the
 * declaration would be acceptable under even the strictest posture — i.e. when the
 * client DID declare something other than `UNKNOWN`. An undeclared post is the
 * common case today and does incur one primary-key lookup on `tenants`. That is
 * deliberate over the alternatives: we cannot know whether a tenant has a
 * `REQUIRED_FOR_AI` override without reading it, and defaulting to "assume not"
 * would silently drop the one posture that has teeth.
 *
 * If that lookup ever shows up in post-latency profiling, the fix is a cached
 * tenant-settings resolver (a KV read with a short TTL, invalidated on tenant
 * update) — NOT skipping the check. `readDisclosurePosture` is the single seam
 * where that cache would land.
 */
export async function gateDeclarationOrRespond(
  db: TenantPostureReader,
  tenantId: string,
  declared: string | undefined,
  platformDefault: DisclosurePosture = DEFAULT_DISCLOSURE_POSTURE,
): Promise<Response | null> {
  // Only `REQUIRED_FOR_AI` can reject, and only a tenant OVERRIDE or the platform
  // default can select it. If neither the default nor any override could be
  // mandatory, there is nothing to check — but we cannot know the override without
  // reading, so the skip only applies when the value is already acceptable under
  // the strictest posture.
  if (validateDeclaration("REQUIRED_FOR_AI", declared) === null) return null;

  const posture = await readDisclosurePosture(db, tenantId, platformDefault);
  const rejection = validateDeclaration(posture, declared);
  if (rejection === null) return null;

  return new Response(
    JSON.stringify({ error: rejection, message: MESSAGES[rejection] }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/**
 * The compose hint: what the client must do about the declaration field for this
 * tenant. Exposed on a capability/compose-config response so the client can render
 * the prompt without knowing the posture vocabulary.
 */
export async function readDeclarationRequirement(
  db: TenantPostureReader,
  tenantId: string,
  platformDefault: DisclosurePosture = DEFAULT_DISCLOSURE_POSTURE,
): Promise<DeclarationRequirement> {
  return declarationRequirement(
    await readDisclosurePosture(db, tenantId, platformDefault),
  );
}
