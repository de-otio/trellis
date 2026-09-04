/**
 * Conformance checks an extension author can run against their own extension.
 *
 * WHY THIS EXISTS
 * ---------------
 * Core validates extensions at boot, but it validates what would make *core*
 * unsafe — a reserved id, a shadowed route prefix, an undeclarable
 * cross-tenant model. It is deliberately permissive about what merely makes an
 * extension *wrong*: an undeclared `extensionApiVersion` is one warning in a
 * log nobody reads, and a route that silently fails to mount is a 404 the
 * author discovers from a bug report.
 *
 * Every defect the extensibility review found in the first downstream vertical
 * was of that second kind. So these checks are stricter than core's on
 * purpose, and the difference is stated per finding rather than implied.
 *
 * The checks are ordinary async functions returning data. There is no runner
 * integration, no plugin registry, and no config file: `assertExtensionConformance`
 * throws an `Error` with a rendered report, which every test runner already
 * knows how to display.
 *
 * WHERE TO CALL THIS FROM — the one constraint
 * --------------------------------------------
 * **In the process that booted the server.** Core's extension registry is
 * in-process state, so `getExtension()` called anywhere else answers "nothing
 * is registered" — which is indistinguishable from a genuinely failed
 * registration and would make the check a liar rather than a no-op.
 *
 * Under a test runner that means the setup file, not a test file: vitest,
 * jest and node:test all run test files in workers with their own module
 * graph. `startStandaloneServer()` therefore runs these checks itself, at
 * boot, by default — which is the one place that is always correct. Calling
 * them by hand is for when you want the findings rather than a throw.
 */

import type { TrellisExtension } from "@de-otio/trellis-extension-api";
import { loadCore } from "./core.js";

/** How much a finding matters. `error` fails {@link assertExtensionConformance}. */
export type ConformanceSeverity = "error" | "warning";

export interface ConformanceFinding {
  /** Stable slug, so a lane can allow-list a finding it has decided to accept. */
  readonly check: string;
  readonly severity: ConformanceSeverity;
  /** What is wrong, in the author's terms. */
  readonly message: string;
  /** What to do about it. */
  readonly fix: string;
}

export interface ConformanceResult {
  /** True when no `error`-severity finding was produced. */
  readonly ok: boolean;
  readonly findings: readonly ConformanceFinding[];
}

export interface ConformanceOptions {
  /** The extension under test — the same object that was registered. */
  readonly extension: TrellisExtension<any>;
  /** Base URL of the running server, e.g. `http://localhost:3100`. */
  readonly apiUrl: string;
  /**
   * Findings whose `check` slug appears here are downgraded to `warning`.
   * For a lane that has consciously accepted one — not for silencing a
   * failure you have not read.
   */
  readonly accept?: readonly string[];
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * The extension is registered, under the id it declares, as the same object.
 *
 * Not redundant with boot: an extension registered under `"dog"` while its
 * author believes it is `"dogs"` boots perfectly and serves nothing at the
 * paths they expect.
 */
async function checkRegistration(ext: TrellisExtension<any>): Promise<ConformanceFinding[]> {
  const { getExtension, getExtensions } = await loadCore();
  const found = getExtension(ext.id);
  if (!found) {
    const ids = getExtensions().map((e) => `"${e.id}"`);
    return [
      {
        check: "registration",
        severity: "error",
        message:
          `no extension is registered under id "${ext.id}". Registered: ` +
          `${ids.length > 0 ? ids.join(", ") : "(none)"}.`,
        fix:
          "Call registerExtension(yourExtension) before startServer(), and " +
          "check that `id` is the value you think it is.",
      },
    ];
  }
  if (found !== ext) {
    return [
      {
        check: "registration",
        severity: "error",
        message:
          `id "${ext.id}" is registered, but to a DIFFERENT object than the ` +
          `one under test. Two copies of the extension are loaded.`,
        fix:
          "Usually a duplicated dependency or a mix of source and built " +
          "imports — import the extension from one place only.",
      },
    ];
  }
  return [];
}

/**
 * `extensionApiVersion` is declared and compatible with the core actually
 * running.
 *
 * Stricter than core deliberately: core treats an absent declaration as one
 * boot warning, because making it fatal would break every extension written
 * before the field existed. A *new* extension has no such excuse, and an
 * undeclared one gets no protection at all against a silently incompatible
 * core — which is the failure this field exists to prevent.
 */
async function checkApiVersion(ext: TrellisExtension<any>): Promise<ConformanceFinding[]> {
  const { classifyApiVersion, EXTENSION_API_VERSION } = await loadCore();
  const verdict = classifyApiVersion(ext.extensionApiVersion, EXTENSION_API_VERSION);
  switch (verdict.kind) {
    case "absent":
      return [
        {
          check: "api-version",
          severity: "error",
          message:
            `extension "${ext.id}" declares no extensionApiVersion, so core ` +
            `cannot verify it was built against the contract it is running on ` +
            `(core provides ${EXTENSION_API_VERSION}).`,
          fix:
            'import { EXTENSION_API_VERSION } from "@de-otio/trellis-extension-api" ' +
            "and set `extensionApiVersion: EXTENSION_API_VERSION` on the extension. " +
            "Importing the constant rather than writing a literal keeps it " +
            "truthful across rebuilds.",
        },
      ];
    case "unparseable":
      return [
        {
          check: "api-version",
          severity: "error",
          message:
            `extension "${ext.id}" declares an extensionApiVersion that is not ` +
            `a version string. Core fails startup on this.`,
          fix: 'Use "<major>.<minor>.<patch>", or the EXTENSION_API_VERSION constant.',
        },
      ];
    case "core-unparseable":
      return [
        {
          check: "api-version",
          severity: "error",
          message: `core reports a malformed extension-api version "${verdict.core}".`,
          fix: "This is a core packaging bug, not an extension problem. Report it.",
        },
      ];
    case "incompatible":
      return [
        {
          check: "api-version",
          severity: "error",
          message:
            `extension "${ext.id}" was built against extension-api ` +
            `${verdict.declared}, core provides ${verdict.core} — ${verdict.reason}.`,
          fix: `Rebuild against ${verdict.core}, or run a core release whose extension-api is ${verdict.declared}.`,
        },
      ];
    case "drift":
      return [
        {
          check: "api-version",
          severity: "warning",
          message:
            `extension "${ext.id}" was built against extension-api ` +
            `${verdict.declared}; core provides ${verdict.core}. Compatible, but drifted.`,
          fix: "Rebuild against the current contract at your convenience.",
        },
      ];
    case "match":
      return [];
  }
}

/** Where core mounts a wrapped extension route. */
function routeUrl(apiUrl: string, extId: string, path: string): string {
  return `${apiUrl}/api/ext/${extId}/${path}`;
}

/**
 * Is a path mounted? Core answers 404 for a path no route claims, and 401 for
 * a mounted `auth: "required"` route reached without a session — so
 * "not 404" is exactly "mounted", with no credentials needed.
 */
async function isMounted(url: string, method: string): Promise<boolean | "unreachable"> {
  try {
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(5_000),
      // A HEAD/GET probe of a POST route must not be mistaken for a body
      // parse failure; we only ever read the status.
    });
    return res.status !== 404;
  } catch {
    return "unreachable";
  }
}

/**
 * Every declared `extensionRoutes` entry answers something other than 404.
 *
 * This check is also self-verifying: it first probes a path the extension does
 * NOT declare and requires a 404 back. Without that, a server answering 200 to
 * everything — a catch-all, a proxy, a dev tunnel — would make every route
 * "mount" and the check would pass by being blind.
 */
async function checkRoutesMount(
  ext: TrellisExtension<any>,
  apiUrl: string,
): Promise<ConformanceFinding[]> {
  const routes = ext.extensionRoutes ?? [];
  if (routes.length === 0) return [];

  const findings: ConformanceFinding[] = [];

  const canary = routeUrl(apiUrl, ext.id, "__testkit_unmounted_canary__");
  const canaryMounted = await isMounted(canary, "GET");
  if (canaryMounted === "unreachable") {
    return [
      {
        check: "routes-mount",
        severity: "error",
        message: `could not reach the server at ${apiUrl} to probe routes.`,
        fix: "Check that the server is running and `apiUrl` points at it.",
      },
    ];
  }
  if (canaryMounted) {
    return [
      {
        check: "routes-mount",
        severity: "error",
        message:
          `${canary} answered something other than 404, but no route declares ` +
          `it. The probe cannot distinguish mounted from unmounted against ` +
          `this server, so the route check was NOT run.`,
        fix:
          "Point `apiUrl` at the Trellis server directly rather than through a " +
          "proxy or catch-all that answers every path.",
      },
    ];
  }

  for (const route of routes) {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const method = methods[0] ?? "GET";
    const url = routeUrl(apiUrl, ext.id, route.path);
    const mounted = await isMounted(url, method);
    if (mounted === "unreachable") {
      findings.push({
        check: "routes-mount",
        severity: "error",
        message: `${method} ${url} was unreachable.`,
        fix: "Check that the server is still running.",
      });
    } else if (!mounted) {
      findings.push({
        check: "routes-mount",
        severity: "error",
        message:
          `${method} ${url} returns 404 — the route is declared but not ` +
          `mounted. (${route.description ?? "no description"})`,
        fix:
          "Declared routes mount automatically, so a 404 means the extension " +
          "core registered is not the one declaring this route — check for a " +
          "stale build, or a `path` with a leading slash.",
      });
    }
  }
  return findings;
}

/**
 * The `crossTenantRead` grant is not obviously dead.
 *
 * WHAT THIS CHECKS, AND WHAT IT DOES NOT
 * --------------------------------------
 * Core already fails startup on a model outside the discover allow-list, so
 * by the time this runs the declaration is *permitted*. What is left is
 * whether it is *used*, and only part of that is decidable here.
 *
 * Decidable, and checked: `discover()` is reachable only through a surface
 * that receives a context — a wrapped route, a job, or `extendRecap`. An
 * extension declaring `crossTenantRead` while declaring none of those has a
 * grant nothing can ever exercise. Likewise a duplicated or empty entry.
 *
 * NOT decidable here, and not checked: whether each declared model is actually
 * read at runtime. An extension with routes that declares five models and
 * reads one passes this check, and that is the exact shape of the over-broad
 * declaration the extensibility review found. Catching it needs core to record
 * which models `discover()` touched during a run; that instrumentation does
 * not exist yet. Stated plainly rather than papered over — a check that
 * implied it covered this would be worse than no check.
 */
function checkCrossTenantRead(ext: TrellisExtension<any>): ConformanceFinding[] {
  const declared = ext.crossTenantRead;
  if (!declared || declared.length === 0) return [];

  const findings: ConformanceFinding[] = [];

  const blank = declared.filter((m) => typeof m !== "string" || m.trim() === "");
  if (blank.length > 0) {
    findings.push({
      check: "cross-tenant-read",
      severity: "error",
      message: `crossTenantRead contains ${blank.length} empty or non-string entr${blank.length === 1 ? "y" : "ies"}.`,
      fix: "Remove them — they grant nothing and hide typos.",
    });
  }

  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const m of declared) {
    if (seen.has(m)) dupes.add(m);
    seen.add(m);
  }
  if (dupes.size > 0) {
    findings.push({
      check: "cross-tenant-read",
      severity: "warning",
      message: `crossTenantRead lists ${[...dupes].join(", ")} more than once.`,
      fix: "De-duplicate the list.",
    });
  }

  const hasConsumer =
    (ext.extensionRoutes?.length ?? 0) > 0 ||
    (ext.jobs?.length ?? 0) > 0 ||
    typeof ext.extendRecap === "function";
  if (!hasConsumer) {
    findings.push({
      check: "cross-tenant-read",
      severity: "error",
      message:
        `extension "${ext.id}" declares crossTenantRead (${declared.join(", ")}) ` +
        `but declares no extensionRoutes, no jobs and no extendRecap — nothing ` +
        `it ships can obtain a context, so nothing can call discover(). The ` +
        `grant is unreachable.`,
      fix:
        "Drop `crossTenantRead`, or add the surface that was going to use it. " +
        "A cross-tenant grant is the widest thing an extension can ask for; " +
        "carrying an unused one costs nothing today and is a real hole the " +
        "day someone adds a route.",
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Run every conformance check and return the findings. Never throws. */
export async function checkExtensionConformance(
  options: ConformanceOptions,
): Promise<ConformanceResult> {
  const { extension, apiUrl } = options;
  const accepted = new Set(options.accept ?? []);

  const findings: ConformanceFinding[] = [
    ...(await checkRegistration(extension)),
    ...(await checkApiVersion(extension)),
    ...(await checkRoutesMount(extension, apiUrl)),
    ...checkCrossTenantRead(extension),
  ].map((f) =>
    accepted.has(f.check) && f.severity === "error" ? { ...f, severity: "warning" as const } : f,
  );

  return { ok: !findings.some((f) => f.severity === "error"), findings };
}

/** Render findings as the body of an error message / a log block. */
export function formatConformanceReport(result: ConformanceResult): string {
  if (result.findings.length === 0) {
    return "conformance: no findings.";
  }
  const lines = result.findings.map(
    (f) => `  [${f.severity}] ${f.check}: ${f.message}\n      fix: ${f.fix}`,
  );
  const errors = result.findings.filter((f) => f.severity === "error").length;
  const warnings = result.findings.length - errors;
  return `conformance: ${errors} error(s), ${warnings} warning(s)\n` + lines.join("\n");
}

/**
 * Run the checks and throw on any `error`-severity finding, with every finding
 * rendered into the message. Warnings are returned, not thrown.
 */
export async function assertExtensionConformance(
  options: ConformanceOptions,
): Promise<ConformanceResult> {
  const result = await checkExtensionConformance(options);
  if (!result.ok) {
    throw new Error(
      `[testkit] extension "${options.extension.id}" is not conformant.\n` +
        formatConformanceReport(result),
    );
  }
  return result;
}
