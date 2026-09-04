/**
 * The public mount (plan 034 lane G).
 *
 * The rule this file exists to keep is one sentence:
 *
 *   **in the spec ⇔ under `/api/v1` ⇔ covered by the additivity gate**
 *
 * The prose above `isPublicRoute` in `lib/routes/index.ts` will be forgotten.
 * The three-way equivalence below will not — it walks the real route table,
 * the really-generated document and the committed gate snapshot, and fails
 * when any one of the three moves without the other two.
 *
 * The rest of the file is the enforcement the mount adds: a public route is
 * authenticated, scope-gated, schema-validated and enveloped, with a
 * `request_id` on every error.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  routes,
  isPublicRoute,
  toPublicPath,
  assertPublicMountWiring,
  buildPublicV1Routes,
  PUBLIC_API_PREFIX,
} from "../../../src/lib/routes/index.js";
import { generateOpenApiDoc } from "../../../src/lib/openapi/generator.js";
import { SessionManager } from "../../../src/lib/session-cookie.js";
import { TenantHandler } from "../../../src/lib/tenant/tenant-handler.js";
import type { Route } from "../../../src/lib/routes/types.js";
import type { Env } from "../../../src/env.js";

// `authMiddleware` is what the *wrapped* handler authenticates with (the
// dispatcher uses SessionManager). Partially mocked so the rest of the module —
// `extractVerifiedTenantId`, used by lib/app.ts — is the real thing.
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/auth/auth-middleware.js")>()),
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
}));

const env = {
  SESSION_SECRET: "test-secret-that-is-at-least-32-chars!!",
} as unknown as Env;

const V1 = `${PUBLIC_API_PREFIX}/`;

function methodsOf(route: Route): string[] {
  if (route.method === undefined || route.method === "*") return ["ALL"];
  return Array.isArray(route.method) ? route.method : [route.method];
}

/** The literal path a route declares, regex or string, slashes unescaped. */
function rawPath(route: Route): string {
  return typeof route.path === "string"
    ? route.path
    : route.path.source.replace(/\\\//g, "/").replace(/^\^/, "").replace(/\$$/, "");
}

/** Every route the app serves inside the public namespace — regex ones too. */
const v1Routes = routes.filter((r) => rawPath(r).startsWith(V1));

/** …of which only the string-path ones are derived by the public mount. */
const derivedV1Routes = v1Routes.filter((r) => typeof r.path === "string");

/**
 * `GET /api/v1/posts/:id/sentiments/users` (routes/sentiments.ts) predates the
 * versioning rule: a first-party route that happens to have `/api/v1` in its
 * literal path. It is allowlisted in `assertPublicMountWiring`, is not public,
 * and must therefore stay out of the document — asserted below rather than
 * quietly filtered.
 */
const LEGACY_V1_PATH_FRAGMENT = "/sentiments/users";

// ═══════════════════════════════════════════════════════════════════════════
// G.4 — the three-way consistency test
// ═══════════════════════════════════════════════════════════════════════════

describe("in the spec ⇔ under /api/v1 ⇔ covered by the additivity gate", () => {
  const doc = generateOpenApiDoc(routes);
  const specPaths = Object.keys(doc.paths);

  it("emits at least one operation — an empty document proves nothing", () => {
    expect(specPaths.length).toBeGreaterThan(0);
  });

  it("every path in the spec is under /api/v1", () => {
    expect(specPaths.filter((p) => !p.startsWith(V1))).toEqual([]);
  });

  it("every path in the spec is a route the app actually mounts", () => {
    // The spec's `{param}` form and the route's `:param` form are the same
    // path; normalise before comparing so a renamed parameter is caught too.
    const mounted = new Set(
      derivedV1Routes.map((r) => (r.path as string).replace(/:([^/]+)/g, "{$1}")),
    );
    expect(specPaths.filter((p) => !mounted.has(p))).toEqual([]);
  });

  it("every route under /api/v1 is in the spec", () => {
    const inSpec = new Set(specPaths);
    const missing = v1Routes
      .filter((r) => !rawPath(r).includes(LEGACY_V1_PATH_FRAGMENT))
      .map((r) => (r.path as string).replace(/:([^/]+)/g, "{$1}"))
      .filter((p) => !inSpec.has(p));
    expect(missing).toEqual([]);
  });

  it("every route under /api/v1 is public, or is the recorded legacy exception", () => {
    for (const route of v1Routes) {
      if (rawPath(route).includes(LEGACY_V1_PATH_FRAGMENT)) {
        // Recorded, not published: no scopes, no publicSpec, absent from the
        // document. If this ever flips, the namespace has an unenforced route.
        expect(isPublicRoute(route)).toBe(false);
        expect(Object.keys(doc.paths)).not.toContain(rawPath(route));
        continue;
      }
      expect(isPublicRoute(route), `${String(route.path)} is mounted under ${PUBLIC_API_PREFIX} but is not public`).toBe(true);
    }
  });

  it("nothing in the spec is missing from the gate's coverage", () => {
    // The additivity gate (`scripts/check-openapi-additivity.mjs`) classifies
    // the live document against this snapshot. A path the snapshot has never
    // seen is a path no gate rule has ever run against — regenerate the
    // snapshot in its own commit when the public surface changes.
    const snapshot = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../openapi.snapshot.json"), "utf8"),
    ) as { paths: Record<string, unknown> };
    const covered = new Set(Object.keys(snapshot.paths));
    expect(specPaths.filter((p) => !covered.has(p))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The rule fails when it is broken
// ═══════════════════════════════════════════════════════════════════════════

describe("assertPublicMountWiring", () => {
  const ok = async () => new Response("ok");

  it("refuses a scope declaration nothing enforces", () => {
    expect(() =>
      assertPublicMountWiring([
        { path: "/api/widgets", method: "POST", handler: ok, scopes: ["posts:write"] },
      ]),
    ).toThrow(/never enforced anywhere/);
  });

  it("refuses a hand-written /api/v1 path", () => {
    expect(() =>
      assertPublicMountWiring([{ path: "/api/v1/widgets", method: "GET", handler: ok }]),
    ).toThrow(/never written by hand/);
  });

  it("refuses a public route that cannot be published under /api/v1", () => {
    // A wildcard has no versioned form: it would swallow the namespace.
    expect(() =>
      assertPublicMountWiring([
        { path: "/api/widgets/*", method: "GET", handler: ok, publicSpec: true, scopes: [] },
      ]),
    ).toThrow(/cannot be published/);
    // …and neither does a root-level document.
    expect(() =>
      assertPublicMountWiring([
        { path: "/llms.txt", method: "GET", handler: ok, publicSpec: true, scopes: [] },
      ]),
    ).toThrow(/cannot be published/);
    // …nor a regex with an unnamed capture, which the spec would emit as
    // `{param0}` and the generator refuses.
    expect(() =>
      assertPublicMountWiring([
        {
          path: /^\/api\/widgets\/([^/]+)$/,
          method: "GET",
          handler: ok,
          publicSpec: true,
          scopes: [],
        },
      ]),
    ).toThrow(/cannot be published/);
  });

  it("accepts the two half-wired states that fail closed", () => {
    expect(() =>
      assertPublicMountWiring([
        // curated for the spec, not yet published — the state markPublicSpec
        // leaves thirteen route sets in.
        { path: "/api/widgets", method: "GET", handler: ok, publicSpec: true },
        // authenticated-no-grant, not curated — published by neither half.
        { path: "/api/gadgets", method: "GET", handler: ok, scopes: [] },
      ]),
    ).not.toThrow();
  });
});

describe("isPublicRoute", () => {
  const ok = async () => new Response("ok");

  it("needs both halves", () => {
    expect(isPublicRoute({ path: "/api/a", handler: ok })).toBe(false);
    expect(isPublicRoute({ path: "/api/a", handler: ok, publicSpec: true })).toBe(false);
    expect(isPublicRoute({ path: "/api/a", handler: ok, scopes: [] })).toBe(false);
    expect(isPublicRoute({ path: "/api/a", handler: ok, publicSpec: true, scopes: [] })).toBe(true);
  });

  it("treats `scopes: []` as a declaration, not an absence", () => {
    // `[]` is "authenticated, no particular grant" — a real answer. `undefined`
    // is "not answered". Collapsing the two would publish every curated route.
    expect(isPublicRoute({ path: "/api/a", handler: ok, publicSpec: true, scopes: [] })).toBe(true);
    expect(isPublicRoute({ path: "/api/a", handler: ok, publicSpec: true, scopes: undefined })).toBe(false);
  });
});

describe("toPublicPath", () => {
  it("replaces the /api prefix rather than stacking on it", () => {
    expect(toPublicPath("/api/users/me/tenants")).toBe("/api/v1/users/me/tenants");
    expect(toPublicPath("/api/users/me/tenants")).not.toContain("/api/v1/api/");
  });

  it("rewrites a named regex capture to a path parameter both routers accept", () => {
    // Hono's regexToHonoPath translates only *unnamed* captures; the OpenAPI
    // generator *requires* named ones on a public route. A `:name` segment is
    // the one form that satisfies both, which is why this returns a string.
    expect(toPublicPath(/^\/api\/tenants\/(?<tenantId>[^/]+)$/)).toBe(
      "/api/v1/tenants/:tenantId",
    );
  });

  it("returns null for anything unpublishable", () => {
    expect(toPublicPath("/llms.txt")).toBeNull();
    expect(toPublicPath("/api/admin/*")).toBeNull();
    expect(toPublicPath("*")).toBeNull();
    expect(toPublicPath(/^\/api\/tenants\/([^/]+)$/)).toBeNull();
    expect(toPublicPath(/\/api\/tenants/)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// What is public today, and what the Flutter client still sees
// ═══════════════════════════════════════════════════════════════════════════

describe("the public surface", () => {
  it("is exactly the operations this lane published", () => {
    // A canary, not a tautology: publishing a route is an authorization
    // decision, so it should never happen as a side effect of an unrelated
    // change. Adding a line here is the deliberate act.
    expect(v1Routes.map((r) => `${methodsOf(r).join("|")} ${rawPath(r)}`).sort()).toEqual([
      // The one route this lane published…
      "GET /api/v1/users/me/tenants",
      // …and the one hand-written literal that predates the namespace
      // (routes/sentiments.ts). It is first-party, unpublished, and recorded
      // in LEGACY_UNENFORCED_V1_PATHS; it must never grow scopes here.
      "GET /api/v1/posts/([^/]+)/sentiments/users",
    ].sort());
  });

  it("leaves every unversioned path exactly where the Flutter client left it", () => {
    // The client calls unversioned `/api/…`. The mount is an *alias*: for each
    // published operation the unversioned twin is still in the table, same
    // method, same handler identity.
    for (const v1 of derivedV1Routes) {
      if (rawPath(v1).includes(LEGACY_V1_PATH_FRAGMENT)) continue;
      const unversioned = "/api/" + (v1.path as string).slice(V1.length);
      const twin = routes.find(
        (r) => r.path === unversioned && methodsOf(r).join("|") === methodsOf(v1).join("|"),
      );
      expect(twin, `no unversioned twin for ${String(v1.path)}`).toBeDefined();
    }
  });

  it("does not publish the unversioned twin — the spec names only the enforced path", () => {
    const twin = routes.find((r) => r.path === "/api/users/me/tenants");
    expect(twin).toBeDefined();
    expect(isPublicRoute(twin!)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The dispatcher, on the real published route
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/users/me/tenants", () => {
  const route = routes.find((r) => r.path === "/api/v1/users/me/tenants")!;
  const ctx = {
    url: new URL("https://api.example.com/api/v1/users/me/tenants"),
    pathname: "/api/v1/users/me/tenants",
    params: {},
  };
  const request = () =>
    new Request("https://api.example.com/api/v1/users/me/tenants", { method: "GET" });

  let getSession: ReturnType<typeof vi.spyOn>;
  let listMyTenants: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getSession = vi.spyOn(SessionManager.prototype, "getSession");
    listMyTenants = vi.spyOn(TenantHandler.prototype, "handleListMyTenants");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is mounted, scope-declaring and specified", () => {
    expect(route).toBeDefined();
    expect(route.scopes).toEqual(["tenant:read"]);
    expect(route.operationId).toBe("listMyTenants");
    expect(route.responseSchema).toBeDefined();
    expect(route.version).toBe("v1");
  });

  it("401s an anonymous caller — a scopes array implies authentication", () => {
    // `requireScope` deliberately does not check authentication: an absent
    // `scopes` reads as first-party `"*"` and passes everything. So an
    // anonymous caller must be stopped before the gate, not by it. This is the
    // `auth: "optional"` question lane A handed over, answered fail-closed.
    getSession.mockResolvedValue(null);
    return route.handler(request(), env, ctx).then(async (res) => {
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("UNAUTHORIZED");
      expect(body.request_id).toBeTruthy();
      expect(body.docs_url).toBe("/openapi.json#operation/listMyTenants");
      expect(listMyTenants).not.toHaveBeenCalled();
    });
  });

  it("403s a credential without the scope, naming it in `remediation`", async () => {
    getSession.mockResolvedValue({
      userId: "u1",
      clientId: "client-1",
      scopes: new Set(["profile:read"]),
    } as never);

    const res = await route.handler(request(), env, ctx);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("INSUFFICIENT_SCOPE");
    expect(body.remediation).toBe(
      "Request the `tenant:read` scope and have the user re-authorize.",
    );
    expect(body.request_id).toBeTruthy();
    expect(body.docs_url).toBe("/openapi.json#operation/listMyTenants");
    // Never reached the handler: a 403 must not be distinguishable from a 403
    // by how long it took or what it read.
    expect(listMyTenants).not.toHaveBeenCalled();
  });

  it("200s a credential that holds the scope", async () => {
    getSession.mockResolvedValue({
      userId: "u1",
      clientId: "client-1",
      scopes: new Set(["tenant:read"]),
    } as never);
    mockAuthMiddleware.mockResolvedValue({ userId: "u1" });
    listMyTenants.mockResolvedValue(
      new Response(JSON.stringify({ memberships: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await route.handler(request(), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memberships: [] });
  });

  it("200s an unscoped first-party session, unchanged", async () => {
    getSession.mockResolvedValue({ userId: "u1", scopes: "*" } as never);
    mockAuthMiddleware.mockResolvedValue({ userId: "u1" });
    listMyTenants.mockResolvedValue(
      new Response(JSON.stringify({ memberships: [] }), { status: 200 }),
    );

    const res = await route.handler(request(), env, ctx);
    expect(res.status).toBe(200);
  });

  it("hands the handler the UNVERSIONED request, so path re-parsing still works", async () => {
    getSession.mockResolvedValue({ userId: "u1", scopes: "*" } as never);
    mockAuthMiddleware.mockResolvedValue({ userId: "u1" });
    listMyTenants.mockResolvedValue(new Response("{}", { status: 200 }));

    await route.handler(request(), env, ctx);

    const [seenRequest] = mockAuthMiddleware.mock.calls[0] as [Request];
    expect(new URL(seenRequest.url).pathname).toBe("/api/users/me/tenants");
  });

  it("emits a response schema, security and a docs anchor into the spec", () => {
    const doc = generateOpenApiDoc(routes);
    const op = doc.paths["/api/v1/users/me/tenants"].get;
    expect(op.operationId).toBe("listMyTenants");
    expect(op.security).toEqual([{ oauth2: ["tenant:read"] }]);
    expect(op["x-stability"]).toBe("beta");
    expect(op.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/listMyTenantsResponse",
    });
    const schema = doc.components!.schemas!["listMyTenantsResponse"] as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties).toHaveProperty("memberships");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The dispatcher's order, on a synthetic route
// ═══════════════════════════════════════════════════════════════════════════

describe("the public dispatcher's pipeline", () => {
  let getSession: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getSession = vi.spyOn(SessionManager.prototype, "getSession");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function publish(overrides: Partial<Route> = {}) {
    const handled = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 201 }));
    const [route] = buildPublicV1Routes([
      {
        path: "/api/widgets",
        method: "POST",
        handler: handled,
        publicSpec: true,
        scopes: ["posts:write"],
        operationId: "createWidget",
        requestSchema: z.object({ name: z.string().min(1) }),
        ...overrides,
      },
    ]);
    return { route, handled };
  }

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://api.example.com/api/v1/widgets", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  // 256 characters — one past the middleware's limit, and a legal HTTP header
  // value, so the request itself constructs and only the middleware objects.
  const OVERLONG_KEY = "k".repeat(256);

  const ctx = {
    url: new URL("https://api.example.com/api/v1/widgets"),
    pathname: "/api/v1/widgets",
    params: {},
  };

  it("scopes BEFORE it validates — a 400 would leak the body shape to a caller who may not send one", async () => {
    const { route, handled } = publish();
    getSession.mockResolvedValue({ userId: "u1", scopes: new Set<string>() } as never);

    // An invalid body AND a missing scope. The answer must be the 403.
    const res = await route.handler(post({ name: "" }), env, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("INSUFFICIENT_SCOPE");
    expect(handled).not.toHaveBeenCalled();
  });

  it("validates the request body against the declared schema", async () => {
    const { route, handled } = publish();
    getSession.mockResolvedValue({ userId: "u1", scopes: new Set(["posts:write"]) } as never);

    const res = await route.handler(post({ name: "" }), env, ctx);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("VALIDATION_FAILED");
    expect(body.field).toBe("name");
    expect(body.request_id).toBeTruthy();
    expect(body.docs_url).toBe("/openapi.json#operation/createWidget");
    expect(handled).not.toHaveBeenCalled();
  });

  it("passes a valid body through to the handler, body intact", async () => {
    const { route, handled } = publish();
    getSession.mockResolvedValue({ userId: "u1", scopes: new Set(["posts:write"]) } as never);

    const res = await route.handler(post({ name: "widget" }), env, ctx);
    expect(res.status).toBe(201);
    const [seen] = handled.mock.calls[0] as [Request];
    expect(await seen.json()).toEqual({ name: "widget" });
  });

  it("applies idempotency to a public write, per lane C's rule", async () => {
    // `routeNeedsIdempotency` defaults to true for publicSpec + mutating, so a
    // published POST is de-duplicated without its author remembering to ask.
    // An invalid key is the cheapest observable proof the middleware ran.
    const { route, handled } = publish();
    getSession.mockResolvedValue({ userId: "u1", scopes: new Set(["posts:write"]) } as never);

    const res = await route.handler(
      post({ name: "widget" }, { "Idempotency-Key": OVERLONG_KEY }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(handled).not.toHaveBeenCalled();
  });

  it("honours an explicit idempotency opt-out", async () => {
    const { route, handled } = publish({ idempotent: false });
    getSession.mockResolvedValue({ userId: "u1", scopes: new Set(["posts:write"]) } as never);

    const res = await route.handler(
      post({ name: "widget" }, { "Idempotency-Key": OVERLONG_KEY }),
      env,
      ctx,
    );
    // The middleware never ran, so the over-long key is simply ignored.
    expect(res.status).toBe(201);
    expect(handled).toHaveBeenCalled();
  });

  it("does not apply idempotency to a public read", async () => {
    const { route, handled } = publish({
      method: "GET",
      requestSchema: undefined,
      operationId: "listWidgets",
    });
    getSession.mockResolvedValue({ userId: "u1", scopes: new Set(["posts:write"]) } as never);

    const res = await route.handler(
      new Request("https://api.example.com/api/v1/widgets", {
        method: "GET",
        headers: { "Idempotency-Key": OVERLONG_KEY },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect(handled).toHaveBeenCalled();
  });

  it("keeps the route's own middleware — rate limiting stays ahead of authentication", () => {
    const limiter = vi.fn();
    const { route } = publish({ middleware: [limiter as never] });
    expect(route.middleware).toEqual([limiter]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G.1 — an extension route can be public
// ═══════════════════════════════════════════════════════════════════════════

describe("extension routes are eligible for the public mount", () => {
  it("publishes an extension route under /api/v1/ext/<id>/<path>", () => {
    // The wrapped extension route as `describedExtensionRoutes` produces it:
    // core's shell, carrying the definition's own self-description.
    const wrapped: Route = {
      path: "/api/ext/dogs/walks",
      method: "POST",
      handler: async () => new Response("ok"),
      publicSpec: true,
      scopes: ["walks:write"],
      operationId: "createWalk",
      requestSchema: z.object({ distanceMetres: z.number().int().positive() }),
    };

    const [published] = buildPublicV1Routes([wrapped]);
    expect(published.path).toBe("/api/v1/ext/dogs/walks");

    // As the aggregate assembles it: the unversioned twin demoted out of the
    // document, the published alias carrying the contract.
    const doc = generateOpenApiDoc([{ ...wrapped, publicSpec: false }, published]);
    expect(Object.keys(doc.paths)).toEqual(["/api/v1/ext/dogs/walks"]);
    expect(doc.paths["/api/v1/ext/dogs/walks"].post.security).toEqual([
      { oauth2: ["walks:write"] },
    ]);
    // A real request body, not `{}` — the point of the whole seam for a
    // client an agent generates from this document.
    expect(
      doc.paths["/api/v1/ext/dogs/walks"].post.requestBody!.content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/createWalkRequest" });
  });
});
