/**
 * Unit tests: the API-origin resolver that replaced three copies of a
 * hard-coded fallback hostname (feed-handler, media-handler, routes/media).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const mockWarn = vi.fn();
vi.mock("../../src/lib/logger.js", () => ({
  getLogger: () => ({ warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { resolveApiOrigin, resetApiOriginWarning } from "../../src/lib/api-origin.js";

describe("resolveApiOrigin", () => {
  beforeEach(() => {
    mockWarn.mockClear();
    resetApiOriginWarning();
  });

  it("uses APP_DOMAIN with a scheme as is when it already has an api. label", () => {
    expect(resolveApiOrigin({ APP_DOMAIN: "https://api.example.com" })).toBe(
      "https://api.example.com",
    );
  });

  it("maps a www. host to api.", () => {
    expect(resolveApiOrigin({ APP_DOMAIN: "https://www.example.com" })).toBe(
      "https://api.example.com",
    );
  });

  it("adds an api. label on the apex when the host has none", () => {
    expect(resolveApiOrigin({ APP_DOMAIN: "https://app.dev.example.com" })).toBe(
      "https://api.example.com",
    );
  });

  it("accepts the bare-host form deployments actually set", () => {
    // Previously `new URL("app.example.com")` threw and the resolver fell
    // back to the compiled-in hostname — for every deployment using the
    // documented bare form.
    expect(resolveApiOrigin({ APP_DOMAIN: "app.example.com" })).toBe(
      "https://api.example.com",
    );
  });

  it("leaves a single-label host alone", () => {
    expect(resolveApiOrigin({ APP_DOMAIN: "https://localhost" })).toBe(
      "https://localhost",
    );
  });

  it("falls back to the request's own origin when APP_DOMAIN is unset", () => {
    const request = new Request("https://api.example.org/api/media/upload");
    expect(resolveApiOrigin({}, request)).toBe("https://api.example.org");
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("returns an empty origin (relative URLs) and warns once when nothing is configured", () => {
    expect(resolveApiOrigin({})).toBe("");
    expect(resolveApiOrigin({})).toBe("");
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it("treats an unparseable APP_DOMAIN like an unset one", () => {
    const request = new Request("https://api.example.org/x");
    expect(resolveApiOrigin({ APP_DOMAIN: "http://[not a host" }, request)).toBe(
      "https://api.example.org",
    );
  });

  it("ships no compiled-in hostname anywhere on the response-URL path", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      "../../src/lib/api-origin.ts",
      "../../src/lib/feed-handler.ts",
      "../../src/lib/media-handler.ts",
      "../../src/lib/routes/media.ts",
      "../../src/lib/cors-handler.ts",
      "../../src/lib/security-headers.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(join(here, rel), "utf8");
      // A literal absolute https origin in a `return` or an array default is
      // the shape every removed fallback had. `'self'`, loopback and the
      // IANA example/test domains are the only literals allowed here.
      const literals = [...src.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
      const offenders = literals.filter(
        (host) =>
          !/\.$/.test(host) && // a template prefix such as `https://www.`
          !/(^|\.)example\.(com|org|net)$/.test(host) &&
          !/^localhost$/.test(host) &&
          !/\.(gstatic|googleapis)\.com$/.test(host) && // CSP font/recaptcha sources
          !/^bsky\.social$/.test(host) &&
          !/\.pages\.dev$/.test(host) &&
          !/\.amazonaws\.com$/.test(host),
      );
      expect(offenders, `${rel} carries a hard-coded host: ${offenders.join(", ")}`).toEqual([]);
    }
  });
});
