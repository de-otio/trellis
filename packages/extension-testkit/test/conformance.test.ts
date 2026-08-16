/**
 * The conformance suite, checked against a real server.
 *
 * Two halves, and both are needed:
 *
 * - the reference extension PASSES, which is what makes the suite usable;
 * - each non-conformant fixture FAILS, on the specific check it breaks, which
 *   is what makes a pass mean anything. A suite that only ever ran against a
 *   conformant fixture would pass identically if every check returned `[]`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertExtensionConformance,
  checkExtensionConformance,
  formatConformanceReport,
} from "../src/index.js";
import { exampleExtension, minimalExtension } from "../src/example/index.js";
import {
  deadCrossTenantGrantExtension,
  staleVersionExtension,
  undeclaredVersionExtension,
} from "../src/example/non-conformant.js";
import { harness, stopHarness } from "./harness.js";

let API_URL: string;

beforeAll(async () => {
  API_URL = (await harness()).url;
}, 180_000);

afterAll(stopHarness);

function errorsFor(result: { findings: readonly { check: string; severity: string }[] }) {
  return result.findings.filter((f) => f.severity === "error").map((f) => f.check);
}

describe("conformance: the reference extension", () => {
  it("passes every check", async () => {
    const result = await checkExtensionConformance({
      extension: exampleExtension,
      apiUrl: API_URL,
    });
    // Assert the findings, not `ok`, and hand the rendered report to vitest as
    // the failure message: "expected true to be false" would send whoever
    // broke this back here to guess which check fired.
    expect(result.findings, formatConformanceReport(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("assertExtensionConformance resolves rather than throwing", async () => {
    await expect(
      assertExtensionConformance({ extension: exampleExtension, apiUrl: API_URL }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("the minimal extension fails only on the version it omits", async () => {
    // The minimal fixture exists to omit every optional field, so it is a
    // conformance failure BY DESIGN — and a precise one: nothing else fires.
    const result = await checkExtensionConformance({
      extension: minimalExtension,
      apiUrl: API_URL,
    });
    expect(errorsFor(result)).toEqual(["api-version"]);
  });
});

describe("conformance: each check fires on a fixture that breaks it", () => {
  it("api-version — an undeclared version is an error here, though core only warns", async () => {
    const result = await checkExtensionConformance({
      extension: undeclaredVersionExtension,
      apiUrl: API_URL,
    });
    expect(errorsFor(result)).toContain("api-version");
    const finding = result.findings.find((f) => f.check === "api-version")!;
    expect(finding.message).toContain("declares no extensionApiVersion");
    // The fix must name the constant, not just the field: writing a literal
    // is how the field goes stale, which is the failure one layer down.
    expect(finding.fix).toContain("EXTENSION_API_VERSION");
  });

  it("api-version — a version from another compatibility window is an error", async () => {
    // Not registered: core refuses to boot with it, so registration is
    // accepted here to isolate the check under test. This is what `accept`
    // is for.
    const result = await checkExtensionConformance({
      extension: staleVersionExtension,
      apiUrl: API_URL,
      accept: ["registration"],
    });
    expect(errorsFor(result)).toEqual(["api-version"]);
    expect(result.findings.find((f) => f.check === "api-version")!.message).toContain("0.1.0");
  });

  it("cross-tenant-read — a grant no surface can reach is an error, though core boots it", async () => {
    const result = await checkExtensionConformance({
      extension: deadCrossTenantGrantExtension,
      apiUrl: API_URL,
    });
    expect(errorsFor(result)).toEqual(["cross-tenant-read"]);
    expect(result.findings.find((f) => f.check === "cross-tenant-read")!.message).toContain(
      "unreachable",
    );
  });

  it("registration — an extension that was never registered is an error", async () => {
    const ghost = { ...minimalExtension, id: "never-registered-ext" };
    const result = await checkExtensionConformance({
      extension: ghost,
      apiUrl: API_URL,
    });
    expect(errorsFor(result)).toContain("registration");
    // The message lists what IS registered, so the usual cause — an id that
    // is not the one you thought — is visible without a second run.
    expect(result.findings.find((f) => f.check === "registration")!.message).toContain(
      `"${exampleExtension.id}"`,
    );
  });

  it("registration — a second copy of the same id is an error, not a pass", async () => {
    // The subtle one: `getExtension(id)` returns something, so an identity
    // check is the only thing that catches a duplicated dependency.
    const impostor = { ...exampleExtension };
    const result = await checkExtensionConformance({
      extension: impostor,
      apiUrl: API_URL,
    });
    expect(errorsFor(result)).toContain("registration");
    expect(result.findings.find((f) => f.check === "registration")!.message).toContain(
      "DIFFERENT object",
    );
  });
});

describe("conformance: the route probe is fail-closed", () => {
  it("reports the real 404 for a path no route declares", async () => {
    // This is the assumption the whole routes-mount check rests on: core
    // answers 404 for an unclaimed path. If that ever changes, the check
    // silently becomes a no-op — so it is asserted directly, not assumed.
    const res = await fetch(`${API_URL}/api/ext/${exampleExtension.id}/__nope__`);
    expect(res.status).toBe(404);
  });

  it("refuses to run the check at all against a server that answers everything", async () => {
    // A catch-all would make every route "mounted". Pointed at a URL where
    // even the canary answers, the check must report that it could not
    // discriminate — not quietly pass.
    const result = await checkExtensionConformance({
      extension: exampleExtension,
      apiUrl: "http://127.0.0.1:1", // nothing listening: every probe errors
    });
    const mount = result.findings.find((f) => f.check === "routes-mount")!;
    expect(mount.severity).toBe("error");
    expect(mount.message).toContain("could not reach the server");
  });

  it("finds every declared route mounted on the real server", async () => {
    const result = await checkExtensionConformance({
      extension: exampleExtension,
      apiUrl: API_URL,
    });
    expect(result.findings.filter((f) => f.check === "routes-mount")).toEqual([]);
    // …and the extension does declare routes, so the empty result above is a
    // pass rather than a vacuous one.
    expect(exampleExtension.extensionRoutes!.length).toBeGreaterThan(0);
  });
});

describe("conformance: accept", () => {
  it("downgrades a named error to a warning, and keeps it in the report", async () => {
    const result = await checkExtensionConformance({
      extension: undeclaredVersionExtension,
      apiUrl: API_URL,
      accept: ["api-version"],
    });
    expect(result.ok).toBe(true);
    // Accepted, not hidden: silencing a finding entirely is how it stops
    // being reconsidered.
    expect(result.findings.map((f) => f.check)).toContain("api-version");
    expect(result.findings.find((f) => f.check === "api-version")!.severity).toBe("warning");
  });
});
