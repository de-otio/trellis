/**
 * Extension Validator
 *
 * Validates extension registrations at startup:
 * - Extension IDs are valid format and not reserved
 * - No duplicate IDs
 * - The declared `extensionApiVersion` is compatible with core's
 *   `EXTENSION_API_VERSION` (absent ⇒ one warning, incompatible ⇒ fail boot)
 * - Routes don't shadow core endpoints
 * - Warns about routes without auth middleware
 */

import {
  EXTENSION_API_VERSION,
  type TrellisExtension,
} from "@de-otio/trellis-extension-api";
import { getLogger, Logger } from "./logger.js";
import { invalidCrossTenantReadModels } from "./extension-discover-db.js";
import { getExtensionModelRegistry } from "./extension-model-registry.js";
import { isCoreGateMiddleware } from "./middleware.js";
import { coreSecretEnvKeysIn } from "./extension-config-keys.js";

const RESERVED_IDS = ["user", "admin", "system", "internal", ""];
const RESERVED_ROUTE_PREFIXES = [
  "/api/auth",
  "/api/admin",
  "/api/internal",
  "/.well-known",
];
const ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

const logger = getLogger();

// ---------------------------------------------------------------------------
// extensionApiVersion — bounded parse + pure compatibility classification
// ---------------------------------------------------------------------------

/**
 * Hard length cap applied BEFORE any regex touches the input. Bounding the
 * input, not just the pattern, is what keeps a hostile or accidentally huge
 * string from becoming a matcher problem at all.
 */
export const MAX_API_VERSION_LENGTH = 64;

/**
 * Deliberately NOT the canonical semver regex: an anchored, bounded shape with
 * fixed digit counts and a single trailing wildcard that can only be reached
 * after three fully-matched numeric groups. Linear-time by construction.
 *
 * The `-`/`+` suffix (pre-release / build metadata) is captured but ignored for
 * comparison — `0.8.0-alpha.1` is treated as `0.8.0`.
 */
const API_VERSION_PATTERN = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})([+-].*)?$/;

/** A parsed `major.minor.patch` triple. Suffixes are already discarded. */
export interface ParsedApiVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Parse a version string under the bounded rule above. Pure and total: any
 * input at all yields either a triple or `null` — never a throw.
 */
export function parseApiVersion(raw: unknown): ParsedApiVersion | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_API_VERSION_LENGTH) return null;
  const m = API_VERSION_PATTERN.exec(raw);
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/**
 * The verdict for one extension's declared API version. A closed union so the
 * caller must handle every case, and so the decision itself stays a pure
 * function that can be unit-tested without booting anything.
 */
export type ApiVersionVerdict =
  /** No declaration — warn once at boot, never fatal. */
  | { readonly kind: "absent" }
  /** Declared, but not a version string under the bounded rule — fatal. */
  | { readonly kind: "unparseable"; readonly raw: unknown }
  /** Core's own constant is malformed — a core packaging bug; fatal. */
  | { readonly kind: "core-unparseable"; readonly core: string }
  /** Outside the compatibility window — fatal. */
  | {
      readonly kind: "incompatible";
      readonly declared: string;
      readonly core: string;
      readonly reason: string;
    }
  /** Inside the compatibility window but not identical — log only. */
  | { readonly kind: "drift"; readonly declared: string; readonly core: string }
  /** Same compatibility window and same triple — silent. */
  | { readonly kind: "match" };

/**
 * Decide how an extension's declared API version relates to core's.
 *
 * Compatibility rule (mirrors the bump policy documented on
 * `EXTENSION_API_VERSION`): a differing MAJOR is always breaking; while the
 * API is still `0.x` a differing MINOR is breaking too, because 0.x minors
 * carry signature changes. Anything else is drift.
 *
 * `core` is a parameter rather than a module constant so the malformed-core
 * branch is reachable in tests.
 */
export function classifyApiVersion(
  declaredRaw: unknown,
  core: string,
): ApiVersionVerdict {
  if (declaredRaw === undefined || declaredRaw === null) {
    return { kind: "absent" };
  }

  const coreParsed = parseApiVersion(core);
  if (coreParsed === null) return { kind: "core-unparseable", core };

  const declared = parseApiVersion(declaredRaw);
  if (declared === null) return { kind: "unparseable", raw: declaredRaw };

  const declaredStr = declaredRaw as string;

  if (declared.major !== coreParsed.major) {
    return {
      kind: "incompatible",
      declared: declaredStr,
      core,
      reason: "a differing major version is a breaking change",
    };
  }
  if (coreParsed.major === 0 && declared.minor !== coreParsed.minor) {
    return {
      kind: "incompatible",
      declared: declaredStr,
      core,
      reason:
        "while the extension API is 0.x, a differing minor version is a breaking change",
    };
  }
  if (
    declared.minor !== coreParsed.minor ||
    declared.patch !== coreParsed.patch
  ) {
    return { kind: "drift", declared: declaredStr, core };
  }
  return { kind: "match" };
}

/**
 * Render an untrusted declared value for an error message: truncated, quoted
 * and escaped, with its true length reported. Keeps a 10 kB or control-character
 * value from turning a boot error into unreadable log spew.
 */
function describeDeclaredValue(raw: unknown): string {
  if (typeof raw !== "string") {
    return `a non-string value of type "${typeof raw}"`;
  }
  const shown = raw.length > 32 ? `${raw.slice(0, 32)}…` : raw;
  return `${JSON.stringify(shown)} (length ${raw.length})`;
}

/**
 * Validate every registered extension. Throws on the first fatal problem —
 * callers (`server.ts`) treat a throw as "do not serve".
 *
 * @param coreApiVersion core's extension-API version; defaults to the shipped
 *   `EXTENSION_API_VERSION` constant and is only overridden by tests.
 */
export function validateExtensions(
  extensions: TrellisExtension[],
  coreApiVersion: string = EXTENSION_API_VERSION,
): void {
  const seen = new Set<string>();
  const undeclaredApiVersion: string[] = [];

  for (const ext of extensions) {
    // Validate ID format
    if (!ID_PATTERN.test(ext.id)) {
      throw new Error(
        `Extension ID "${ext.id}" must be lowercase alphanumeric, 2-32 chars`,
      );
    }
    if (RESERVED_IDS.includes(ext.id)) {
      throw new Error(`Extension ID "${ext.id}" is reserved`);
    }
    if (seen.has(ext.id)) {
      throw new Error(`Duplicate extension ID "${ext.id}"`);
    }
    seen.add(ext.id);

    // Extension-API compatibility (plan §4-T5). An extension compiled against
    // a different contract can typecheck at its own build time and still call
    // a hook signature core no longer has — so this is a boot gate, not a
    // runtime surprise.
    const verdict = classifyApiVersion(ext.extensionApiVersion, coreApiVersion);
    switch (verdict.kind) {
      case "absent":
        undeclaredApiVersion.push(ext.id);
        break;
      case "unparseable":
        throw new Error(
          `Extension "${ext.id}" declares an unparseable extensionApiVersion: ` +
            `${describeDeclaredValue(verdict.raw)}. Expected "<major>.<minor>.<patch>" ` +
            `(each part 1-4 digits, optional "-"/"+" suffix, at most ` +
            `${MAX_API_VERSION_LENGTH} characters). Core provides extension-api ` +
            `${coreApiVersion}.`,
        );
      case "core-unparseable":
        throw new Error(
          `Core extension-api version "${verdict.core}" is not a parseable ` +
            `version — this is a core packaging bug, not an extension problem.`,
        );
      case "incompatible":
        throw new Error(
          `Extension "${ext.id}" was built against extension-api ` +
            `${verdict.declared} but core provides extension-api ` +
            `${verdict.core} — ${verdict.reason}. Rebuild the extension ` +
            `against ${verdict.core}, or run a core release whose ` +
            `extension-api matches ${verdict.declared}.`,
        );
      case "drift":
        logger.warn(
          `Extension "${ext.id}" was built against extension-api ` +
            `${verdict.declared}; core provides ${verdict.core}. Compatible, ` +
            `but the versions have drifted — rebuild to stay in lockstep.`,
        );
        break;
      case "match":
        break;
    }

    // Validate routes don't shadow core endpoints
    for (const route of ext.routes) {
      const path =
        typeof route.path === "string"
          ? route.path
          : route.path instanceof RegExp
            ? route.path.source
            : String(route.path);
      for (const prefix of RESERVED_ROUTE_PREFIXES) {
        if (
          path.startsWith(prefix) ||
          path.startsWith(prefix.replace(/\//g, "\\/"))
        ) {
          throw new Error(
            `Extension "${ext.id}" route "${path}" conflicts with reserved prefix "${prefix}"`,
          );
        }
      }
    }

    // Validate the cross-tenant discover declaration (05a §4.4(1)) — fail
    // startup, not first request, on any model not in the core discover
    // allow-list ∪ this extension's own (ext_*) models.
    const ownModels = getExtensionModelRegistry().map((e) => e.model);
    const invalid = invalidCrossTenantReadModels(ext.crossTenantRead, ownModels);
    if (invalid.length > 0) {
      throw new Error(
        `Extension "${ext.id}" declares crossTenantRead model(s) not permitted for cross-tenant discovery: ${invalid.join(", ")}`,
      );
    }

    // SEC M5 — REJECT (was: warn) raw `ext.routes` without auth middleware.
    //
    // `routes/index.ts` splices raw extension routes straight into the core
    // route table: core applies NO auth, NO CSRF, NO security headers, and the
    // handler receives the full core `Env` — SESSION_SECRET, DATABASE_URL, every
    // KV binding and queue. A raw route with no auth middleware is therefore an
    // unauthenticated endpoint with total core access, and a warning in the boot
    // log is not a control. The wrapped path (`extensionRoutes` →
    // `wrapExtensionRoutes`) is the supported way to add routes: core enforces
    // auth, CORS, CSRF and hands the handler a scoped `ExtensionContext`
    // instead of `Env`.
    //
    // Sweep C7 — the check is on middleware IDENTITY, not on the function's
    // name. It used to read `m.name === "authMiddleware" || "csrfMiddleware"`,
    // which is the label on the function object and therefore something the
    // extension writes itself: `function authMiddleware(_c, next) { return
    // next(); }` satisfied it while defending nothing (this file's own test
    // proved it with a no-op), and core's real `csrfMiddleware()` — an
    // anonymous arrow whose `.name` is `""` — was REJECTED. The one mount that
    // bypasses every core gate was guarded by a string an attacker's
    // extension supplies. `isCoreGateMiddleware` reads a non-enumerable
    // `Symbol.for` tag that only `middleware.ts` stamps.
    for (const route of ext.routes) {
      const hasGate = route.middleware?.some(isCoreGateMiddleware);
      if (!hasGate) {
        throw new Error(
          `Extension "${ext.id}" raw route "${route.description ?? String(route.path)}" ` +
            `carries no core gate middleware. Raw ext.routes bypass core auth/CSRF and ` +
            `receive the full core Env (SESSION_SECRET, DATABASE_URL, KV bindings). ` +
            `A locally-defined middleware does not count however it is named — attach ` +
            `\`requireSessionMiddleware()\` or \`csrfMiddleware()\` imported from ` +
            `"@de-otio/trellis/dist/lib/middleware.js", or — preferred — declare the ` +
            `route under \`extensionRoutes\` so core wraps it (auth enforced, scoped ` +
            `ExtensionContext).`,
        );
      }
    }

    // Sweep C8 — an extension may not name a core secret in its configSchema.
    //
    // `createExtensionContext` populates `ctx.config` from `process.env` for
    // every key the schema declares, so before this check
    // `z.object({ SESSION_SECRET: z.string() })` was a one-line request for the
    // session-signing key — while the package docs promised "the extension
    // never sees core secrets such as SESSION_SECRET, DATABASE_URL, or API
    // keys". Refused at boot, and dropped again in `extractExtensionConfig`,
    // so the promise is now enforced at both ends rather than asserted in prose.
    if (ext.configSchema && "shape" in ext.configSchema) {
      const declared = Object.keys(
        (ext.configSchema as unknown as { shape: Record<string, unknown> }).shape,
      );
      const denied = coreSecretEnvKeysIn(declared);
      if (denied.length > 0) {
        throw new Error(
          `Extension "${ext.id}" declares core secret env key(s) in its configSchema: ` +
            `${denied.join(", ")}. ExtensionContext.config carries the extension's own ` +
            `configuration only — core credentials are never handed across the seam. ` +
            `Remove the key(s); if the extension genuinely needs a secret, give it its ` +
            `own env var and its own value.`,
        );
      }
    }
  }

  // One warning per boot, not one per extension: an operator running five
  // undeclared extensions needs the fact once, with the names, not five lines.
  if (undeclaredApiVersion.length > 0) {
    logger.warn(
      `Extension(s) ${undeclaredApiVersion.map((id) => `"${id}"`).join(", ")} ` +
        `declare no extensionApiVersion. Core cannot verify they were built ` +
        `against extension-api ${coreApiVersion}; set ` +
        `extensionApiVersion: EXTENSION_API_VERSION in the extension to enable ` +
        `the startup compatibility check.`,
    );
  }
}
