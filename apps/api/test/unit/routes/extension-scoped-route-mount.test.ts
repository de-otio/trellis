/**
 * Sweep C6 — a PRIVATE extension route with scopes must boot.
 *
 * `extension.ts` publishes this contract for `extensionRoutes[].scopes`:
 * absent = first-party only, `[]` = any authenticated caller, non-empty =
 * every listed scope required. The third case was unreachable for a route that
 * was not also `publicSpec`: `describedExtensionRoutes` copies `def.scopes`
 * onto the core `Route`, and `assertPublicMountWiring` — which
 * `buildPublicV1Routes()` runs over a table that includes extension routes —
 * threw for non-empty `scopes` without `publicSpec`, with a message asserting
 * the scopes are "never enforced anywhere". For an extension route that was
 * simply false: `wrapExtensionRoute` runs `requireScope` inside the handler it
 * emits, on the unversioned `/api/ext/...` mount. So the declaration the docs
 * describe could not boot, and a scope could be attached to an extension route
 * only by also publishing it.
 *
 * The registry is mocked rather than mutated: `registerExtension` appends to a
 * module-level array with no reset, and `public-mount.test.ts` walks the real
 * route table.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { TrellisExtension } from "@de-otio/trellis-extension-api";

const { registered } = vi.hoisted(() => ({
  registered: [] as TrellisExtension[],
}));
vi.mock("../../../src/extensions.js", () => ({
  getExtensions: () => registered,
  getExtension: (id: string) => registered.find((e) => e.id === id),
  registerExtension: (ext: TrellisExtension) => {
    registered.push(ext);
  },
}));

const { buildPublicV1Routes, assertPublicMountWiring, PUBLIC_API_PREFIX } =
  await import("../../../src/lib/routes/index.js");
const { registerExtension } = await import("../../../src/extensions.js");
const { wrapExtensionRoute } = await import("../../../src/lib/extension-route-wrapper.js");

function makeExtension(overrides: Partial<TrellisExtension> = {}): TrellisExtension {
  return {
    id: "dog",
    terminology: { entity: "dog", entityPlural: "dogs" },
    routes: [],
    metadataSchema: z.object({}),
    ...overrides,
  };
}

describe("a private extension route with scopes (C6)", () => {
  it("boots — buildPublicV1Routes() does not refuse it", () => {
    registerExtension(
      makeExtension({
        id: "dog",
        extensionRoutes: [
          {
            path: "private-walks",
            method: "GET",
            scopes: ["dog:walks:read"],
            handler: async () => ({ walks: [] }),
          },
        ] as any,
      }),
    );

    // The whole point: on the old code this threw
    // "Only the /api/v1 mount checks a core route's scopes".
    expect(() => buildPublicV1Routes()).not.toThrow();
  });

  it("stays private — it is not aliased under /api/v1", () => {
    const published = buildPublicV1Routes().map((r) => String(r.path));
    expect(
      published.some((p) => p.includes("private-walks")),
      "a route without publicSpec must not reach the public mount",
    ).toBe(false);
  });

  it("declares where its gate lives, so the exemption is not a path guess", () => {
    const route = wrapExtensionRoute(makeExtension(), {
      path: "private-walks",
      method: "GET",
      scopes: ["dog:walks:read"],
      handler: async () => ({}),
    } as any);
    expect(route.scopesEnforcedBy).toBe("extension-wrapper");
    expect(String(route.path).startsWith("/api/ext/")).toBe(true);
  });
});

describe("assertPublicMountWiring keeps the rule for everything else", () => {
  const ok = async () => new Response("ok");

  it("still refuses a hand-written core route with scopes and no publicSpec", () => {
    // The exemption is for routes whose gate really is elsewhere. A core route
    // has no such gate, so the original rule must survive intact.
    expect(() =>
      assertPublicMountWiring([
        { path: "/api/widgets", method: "POST", handler: ok, scopes: ["posts:write"] },
      ]),
    ).toThrow(/never enforced anywhere/);
  });

  it("accepts the same declaration once it says the wrapper enforces it", () => {
    expect(() =>
      assertPublicMountWiring([
        {
          path: `/api/ext/dog/walks`,
          method: "GET",
          handler: ok,
          scopes: ["dog:walks:read"],
          scopesEnforcedBy: "extension-wrapper",
        },
      ]),
    ).not.toThrow();
  });

  it("does not let the marker excuse a hand-written /api/v1 path", () => {
    // The exemption is scoped to ONE of the three rules. A marker on a route
    // squatting the public namespace must still fail.
    expect(() =>
      assertPublicMountWiring([
        {
          path: `${PUBLIC_API_PREFIX}/widgets`,
          method: "GET",
          handler: ok,
          scopesEnforcedBy: "extension-wrapper",
        },
      ]),
    ).toThrow(/never written by hand/);
  });

  it("does not let the marker excuse an unpublishable public route", () => {
    expect(() =>
      assertPublicMountWiring([
        {
          path: "/api/widgets/*",
          method: "GET",
          handler: ok,
          publicSpec: true,
          scopes: [],
          scopesEnforcedBy: "extension-wrapper",
        },
      ]),
    ).toThrow(/cannot be published/);
  });
});
