/**
 * Stream 2.1 H0 — proof of the Hono migration seam.
 *
 * Asserts that:
 *   - /health is served by the Hono app, with the same security headers the
 *     legacy global middleware applied;
 *   - an unknown path returns the real 404 (Hono is the sole router; the
 *     legacy fallback was removed in H-final).
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";

import {
  buildHonoApp,
  HONO_PORTED_PATHS,
  toHonoMiddleware,
  corsMiddleware,
  regexToHonoPath,
} from "../../src/lib/app.js";
import { csrfMiddleware } from "../../src/lib/middleware.js";
import type { Route } from "../../src/lib/routes/types.js";
import type { Env } from "../../src/env.js";

// Minimal env — /health uses only SecurityHeaders(env) and the (fail-open)
// OpenAiBudget; neither requires a populated env for this test.
const env = {} as unknown as Env;

describe("Hono app seam (H0)", () => {
  it("serves /health via Hono with security headers", async () => {
    const app = buildHonoApp();

    const res = await app.fetch(new Request("http://localhost/health"), {
      trellisEnv: env,
      requestContext: undefined,
    });

    expect(res.status).toBe(200);
    // Security headers applied by SecurityHeaders.createSecureResponse,
    // identical to the legacy global securityHeadersMiddleware.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");

    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns the real 404 (with security headers) for an unknown path", async () => {
    const app = buildHonoApp();

    const res = await app.fetch(new Request("http://localhost/totally-unknown-xyz"), {
      trellisEnv: env,
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await res.json()) as { error: string }).toMatchObject({ error: "Not found" });
  });

  it("declares the ported health.ts paths", () => {
    expect(HONO_PORTED_PATHS).toContain("/health");
    expect(HONO_PORTED_PATHS).toContain("/api/config");
    expect(HONO_PORTED_PATHS).toContain("/api/csrf-token");
  });

  it("serves a non-empty /openapi.json describing exactly the published surface", async () => {
    // Regression guard: /openapi.json was mounted with an empty route getter,
    // so it served a valid-but-empty spec while llms.txt advertised a full
    // one. It is now wired to the curated registry.
    //
    // Plan 034 narrowed what "curated" publishes. Before, `publicSpec: true`
    // alone put a route in the document, so the whole federation surface
    // appeared with `{param0}` positional parameters and no `security` — a
    // document that named paths nothing enforced scopes on. Publication now
    // additionally requires a `scopes` declaration, and a published route is
    // mounted under /api/v1 behind the public dispatcher. So this asserts the
    // rule, not a route list: whatever is in the document is versioned and
    // scope-declared, and no first-party surface leaks into it. The route-level
    // detail lives in test/unit/routes/public-mount.test.ts.
    const app = buildHonoApp();
    const res = await app.fetch(new Request("http://localhost/openapi.json"), {
      trellisEnv: env,
    });
    expect(res.status).toBe(200);

    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, { security?: unknown }>>;
    };
    expect(doc.openapi).toBe("3.1.0");

    const paths = Object.keys(doc.paths);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain("/api/v1/users/me/tenants");

    for (const p of paths) {
      expect(p.startsWith("/api/v1/"), `${p} is in the spec but not under /api/v1`).toBe(true);
      // No positional `{paramN}` placeholders: a published path names its
      // parameters, or the generator refuses to emit it at all.
      expect(p).not.toMatch(/\{param\d+\}/);
      // No first-party surface (posts, comments, media, ActivityPub, …).
      expect(p).not.toMatch(/\/posts|\/comments|\/media|\/sentiments|webfinger/);
      for (const op of Object.values(doc.paths[p])) {
        expect(op.security, `${p} is published without security`).toBeDefined();
      }
    }
  });

  it("registers every ported path on the Hono router (H3 batch)", () => {
    // The ported surface includes the (gated) ActivityPub federation routes;
    // enable federation so this porting-completeness check sees them.
    process.env.ACTIVITYPUB_ENABLED = "true";
    const app = buildHonoApp();
    delete process.env.ACTIVITYPUB_ENABLED;
    const registered = new Set(app.routes.map((r) => r.path));

    // Every declared ported path must be registered by mount().
    for (const path of HONO_PORTED_PATHS) {
      expect(registered.has(path)).toBe(true);
    }

    // H3 + H4 added exact-string route files beyond health.ts.
    for (const path of [
      // H3 (note: /api/auth/discover is intentionally un-ported — shadowed
      // by auth.ts's /api/auth/* wildcard in legacy; see app.ts)
      "/api/feature-flags",
      "/api/user/profile",
      "/api/mfa/status",
      "/api/map/nearby",
      "/api/user/delete-account",
      // H4 (the legacy /api/friends endpoints were removed in the
      // pre-launch schema end-state pass — connections go through
      // /api/connection-codes + the relationships graph)
      "/api/circles/members",
      "/api/relationships/score",
      "/api/entity-relationships/pending",
      "/api/taxonomy/metrics",
      "/agents/authorize",
      "/out",
      // H5 — activitypub (:param string paths)
      "/users/:username",
      "/posts/:postId",
      "/groups/:groupId/inbox",
      "/entities/:entityType/:entityId",
      "/.well-known/webfinger",
      "/api/audiences/:audienceId/members",
      // H10 — wildcard files + re-mounted discover
      "/api/auth/*",
      "/api/auth/discover",
      "/auth/*",
      "/api/feeds/entity/*",
      "/api/internal/docs/*",
      "/api/admin/super-admin/*",
    ]) {
      expect(HONO_PORTED_PATHS).toContain(path);
      expect(registered.has(path)).toBe(true);
    }
  });

  it("applies CORS headers to a ported route (GET /api/config)", async () => {
    const app = buildHonoApp();

    const res = await app.fetch(new Request("http://localhost/api/config"), {
      trellisEnv: env,
    });

    // Handler returns 500 without a requestContext, but CORS middleware still
    // decorates the response, and security headers are applied per-route.
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("serves POST /api/auth/discover from the dedicated discover handler, not the auth wildcard (un-shadowed)", async () => {
    const app = buildHonoApp();
    // No body → the discover handler returns its distinctive INVALID_JSON
    // error. The auth wildcard handler does not produce this shape, so it
    // proves discover (registered before the wildcard) wins.
    const res = await app.fetch(
      new Request("http://localhost/api/auth/discover", { method: "POST" }),
      { trellisEnv: env },
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "INVALID_JSON" });
  });

  it("answers OPTIONS preflight on a GET-only route (cross-origin web client)", async () => {
    // The per-route mount registers only declared methods, but browsers send a
    // CORS preflight (OPTIONS) before a cross-origin write. The global
    // app.options("*") handler answers it with 204 + CORS headers, reflecting an
    // allow-listed Origin — otherwise the Flutter web client (served from a
    // different origin than api.<domain>) is blocked. /api/config is GET-only;
    // the preflight is still served.
    const app = buildHonoApp();

    // SEC M4: CORS now fails closed when NEITHER APP_DOMAIN nor
    // ALLOWED_ORIGINS is configured (it used to reflect any origin, with
    // credentials). Configure the app domain so this test exercises preflight
    // handling rather than the — now removed — fail-open reflection.
    const corsEnv = { APP_DOMAIN: "https://example.com" } as unknown as Env;

    const res = await app.fetch(
      new Request("http://localhost/api/config", {
        method: "OPTIONS",
        headers: { Origin: "https://example.com" },
      }),
      { trellisEnv: corsEnv },
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://example.com",
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("toHono :param extraction (H5)", () => {
  it("passes Hono-extracted path params to the legacy handler as `params`", async () => {
    // A legacy handler reads params.username (e.g. activitypub/actor.ts). Hono
    // extracts :username from the path; toHono must forward it identically.
    const app = new Hono();
    const route: Route = {
      path: "/users/:username",
      method: "GET",
      handler: (_req, _env, { params }) =>
        Promise.resolve(
          new Response(JSON.stringify({ username: params?.username }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    };
    // Mount via the same adapter path used by buildHonoApp.
    app.get("/users/:username", toHonoMiddleware(corsMiddleware()), (c) => {
      const url = new URL(c.req.url);
      return route.handler(c.req.raw, {} as never, {
        url,
        pathname: url.pathname,
        params: c.req.param(),
        requestContext: undefined,
      });
    });

    const res = await app.fetch(new Request("http://localhost/users/alice"), {
      trellisEnv: env,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "alice" });
  });
});

describe("regexToHonoPath (H7)", () => {
  it("translates anchored ([^/]+) and (.+) captures to :pN params", () => {
    expect(regexToHonoPath(/^\/api\/users\/me\/agent-sessions\/([^/]+)\/revoke$/)).toBe(
      "/api/users/me/agent-sessions/:p0/revoke",
    );
    expect(regexToHonoPath(/^\/api\/posts\/([^/]+)$/)).toBe("/api/posts/:p0");
    expect(regexToHonoPath(/^\/api\/x\/([^/]+)\/y\/([^/]+)$/)).toBe("/api/x/:p0/y/:p1");
    // Greedy (.+) treated as single-segment (multi-segment falls to legacy).
    expect(regexToHonoPath(/^\/api\/invitations\/(.+)$/)).toBe("/api/invitations/:p0");
    expect(regexToHonoPath(/^\/api\/dashboard\/moderation\/posts\/(.+)\/action$/)).toBe(
      "/api/dashboard/moderation/posts/:p0/action",
    );
    // Escaped literal dot is preserved.
    expect(regexToHonoPath(/^\/api\/tenants\/([^/]+)\/compliance\.json$/)).toBe(
      "/api/tenants/:p0/compliance.json",
    );
  });

  it("returns null for unsafe / unanchored / metachar patterns (defer them)", () => {
    expect(regexToHonoPath(/\/api\/posts\/([^/]+)/)).toBeNull(); // unanchored
    expect(regexToHonoPath(/^\/api\/posts\/(\d+)$/)).toBeNull(); // non-([^/]+)/(.+) capture
    expect(regexToHonoPath(/^\/api\/(a|b)$/)).toBeNull(); // alternation
    expect(regexToHonoPath(/^\/api\/x\/.$/)).toBeNull(); // bare . (any-char)
  });
});

describe("agent-sessions revoke route via Hono (H7)", () => {
  it("routes POST /api/users/me/agent-sessions/:id/revoke to the handler", async () => {
    const app = buildHonoApp();
    const res = await app.fetch(
      new Request("http://localhost/api/users/me/agent-sessions/sess-123/revoke", {
        method: "POST",
      }),
      { trellisEnv: env },
    );
    // No auth → handler returns 401 (not a 404), proving Hono matched the
    // translated regex route and reached the revoke handler.
    expect(res.status).toBe(401);
  });
});

describe("blocks route via Hono (H4)", () => {
  it("routes GET /api/blocks to the handler (unauthenticated → 401)", async () => {
    const app = buildHonoApp();
    const res = await app.fetch(new Request("http://localhost/api/blocks"), {
      trellisEnv: env,
    });
    // No auth → handler returns 401 (not a 404), proving Hono matched the
    // mounted blockRoutes and reached the handler.
    expect(res.status).toBe(401);
  });
});

describe("Hono precedence is registration-order, not specificity (H10)", () => {
  it("a specific route registered BEFORE a covering wildcard wins; the wildcard handles the rest", async () => {
    // Hono runs matching handlers in registration order (first to return wins),
    // NOT by path specificity. This is why buildHonoApp mounts
    // authDiscoverRoutes BEFORE the auth wildcard to un-shadow
    // POST /api/auth/discover.
    const app = new Hono();
    app.post("/api/auth/discover", (c) => c.json({ via: "specific" }));
    app.all("/api/auth/*", (c) => c.json({ via: "wildcard" }));

    const specific = await app.fetch(
      new Request("http://localhost/api/auth/discover", { method: "POST" }),
      { trellisEnv: env },
    );
    expect(await specific.json()).toEqual({ via: "specific" });

    const wild = await app.fetch(
      new Request("http://localhost/api/auth/login", { method: "POST" }),
      { trellisEnv: env },
    );
    expect(await wild.json()).toEqual({ via: "wildcard" });
  });

  it("confirms the inverse: wildcard registered first shadows a later specific route", async () => {
    const app = new Hono();
    app.all("/api/auth/*", (c) => c.json({ via: "wildcard" }));
    app.post("/api/auth/discover", (c) => c.json({ via: "specific" }));
    const res = await app.fetch(
      new Request("http://localhost/api/auth/discover", { method: "POST" }),
      { trellisEnv: env },
    );
    expect(await res.json()).toEqual({ via: "wildcard" });
  });
});

describe("legacy-middleware Hono adapter (H1)", () => {
  it("runs the downstream handler when middleware calls next() (CSRF pass-through)", async () => {
    // csrfMiddleware skips when there is no session secret / session, so an
    // unauthenticated POST falls through to the handler — proving the adapter
    // bridges next() correctly.
    const app = new Hono();
    app.post("/t", toHonoMiddleware(csrfMiddleware()), (c) => c.json({ reached: true }));

    const res = await app.fetch(
      new Request("http://localhost/t", { method: "POST" }),
      { trellisEnv: env },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
  });

  it("short-circuits without running the handler (CORS OPTIONS)", async () => {
    let reached = false;
    const app = new Hono();
    app.use("/t", toHonoMiddleware(corsMiddleware()));
    app.get("/t", (c) => {
      reached = true;
      return c.json({ reached });
    });

    const res = await app.fetch(
      new Request("http://localhost/t", { method: "OPTIONS" }),
      { trellisEnv: env },
    );

    expect(res.status).toBe(204);
    expect(reached).toBe(false);
  });
});
