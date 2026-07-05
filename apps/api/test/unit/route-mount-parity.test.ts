/**
 * Route-mount parity guard.
 *
 * Trellis is mid-migration to Hono: the SERVED route table is the explicit
 * `PORTED_ROUTE_SETS` mount list in `lib/app.ts`; `lib/routes/index.ts` is
 * only the curated `publicSpec` aggregate (the OpenAPI generator's data
 * source). A route added to routes/index.ts but NOT mounted in app.ts passes
 * its unit tests and then 404s in production — exactly what happened to the
 * T8 `devicesRoutes` (POST /api/devices/register) in 0.19.0, and, found by
 * this guard, to the T1/T3/T4/T5 tenant-directory route sets.
 *
 * The parity test below fails the build whenever any route in the aggregate
 * is not registered on the built Hono app, closing the whole defect class.
 * Routes *intentionally* not yet ported must be listed (with a reason) in
 * MOUNT_ALLOWLIST.
 */

import { describe, it, expect, vi } from "vitest";

import { buildHonoApp, regexToHonoPath } from "../../src/lib/app.js";
import { routes as aggregatedRoutes } from "../../src/lib/routes/index.js";
import type { Route } from "../../src/lib/routes/types.js";
import type { Env } from "../../src/env.js";

const env = {} as unknown as Env;

/**
 * Routes present in the routes/index.ts aggregate that are INTENTIONALLY not
 * mounted on the Hono app. Every entry must carry a comment saying why and a
 * tracking reference — this list is the only sanctioned way past the guard.
 *
 * Key format: `"<METHOD> <hono-path>"` (method `ALL` for `*`/undefined;
 * regex paths in their `regexToHonoPath` translation, or `String(path)` if
 * untranslatable).
 */
const MOUNT_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // (empty — all aggregated routes are currently mounted)
]);

function methodsOf(route: Route): string[] {
  if (route.method === undefined || route.method === "*") return ["ALL"];
  return Array.isArray(route.method) ? route.method : [route.method];
}

/** The Hono path a route would be mounted under (null = untranslatable). */
function honoPathOf(route: Route): string | null {
  return typeof route.path === "string"
    ? route.path
    : regexToHonoPath(route.path);
}

type AppModule = typeof import("../../src/lib/app.js");
type RoutesModule = typeof import("../../src/lib/routes/index.js");

/**
 * Core of the guard: every route in the aggregate (minus the trailing 404
 * catch-all and the allowlist) must be registered on the built Hono app,
 * matching on method + translated path. A route mounted via `.all()` (method
 * "ALL") covers any specific method on that path.
 */
function findUnmountedRoutes(appModule: AppModule, routesModule: RoutesModule): string[] {
  const app = appModule.buildHonoApp();
  const registered = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
  const registeredAllPaths = new Set(
    app.routes.filter((r) => r.method === "ALL").map((r) => r.path),
  );

  const missing: string[] = [];
  for (const route of routesModule.routes) {
    // The aggregate's trailing 404 catch-all is not a servable route; Hono
    // has its own notFound handler.
    if (route.path === "*") continue;

    const honoPath =
      typeof route.path === "string"
        ? route.path
        : appModule.regexToHonoPath(route.path);

    for (const method of methodsOf(route)) {
      const key = `${method} ${honoPath ?? String(route.path)}`;
      if (MOUNT_ALLOWLIST.has(key)) continue;
      const mounted =
        honoPath !== null &&
        (registered.has(`${method} ${honoPath}`) ||
          registeredAllPaths.has(honoPath));
      if (!mounted) {
        missing.push(
          `${key}  (${route.description ?? "no description"}) — add its route set to PORTED_ROUTE_SETS in lib/app.ts, or allowlist it here with a reason`,
        );
      }
    }
  }
  return missing;
}

describe("route-mount parity (routes/index.ts aggregate vs app.ts Hono mounts)", () => {
  it("mounts every aggregated route on the Hono app (federation off — default)", async () => {
    const appModule = await import("../../src/lib/app.js");
    const routesModule = await import("../../src/lib/routes/index.js");
    expect(findUnmountedRoutes(appModule, routesModule)).toEqual([]);
  });

  it("mounts every aggregated route on the Hono app (federation on)", async () => {
    // routes/index.ts reads ACTIVITYPUB_ENABLED at module load; re-import
    // both modules with the flag set so the federation surface is included
    // on both sides of the comparison.
    vi.resetModules();
    process.env.ACTIVITYPUB_ENABLED = "true";
    try {
      const appModule = (await import("../../src/lib/app.js")) as AppModule;
      const routesModule = (await import(
        "../../src/lib/routes/index.js"
      )) as RoutesModule;
      expect(findUnmountedRoutes(appModule, routesModule)).toEqual([]);
    } finally {
      delete process.env.ACTIVITYPUB_ENABLED;
      vi.resetModules();
    }
  });

  it("keeps the allowlist honest: no allowlisted route is actually mounted", async () => {
    // An allowlist entry for a route that IS mounted is stale — remove it so
    // the guard stays tight.
    const app = buildHonoApp();
    const registered = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    for (const entry of MOUNT_ALLOWLIST) {
      expect(registered.has(entry), `stale allowlist entry: ${entry}`).toBe(false);
    }
  });
});

describe("served-route regression: T8 devices routes (the 0.19.0 mount gap)", () => {
  it("serves POST /api/devices/register via the Hono app (401 unauth, NOT 404)", async () => {
    const app = buildHonoApp();
    const res = await app.fetch(
      new Request("http://localhost/api/devices/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "t", platform: "fcm" }),
      }),
      { trellisEnv: env },
    );
    // 401 proves the route is MOUNTED and the request reached the devices
    // handler's auth gate; the 0.19.0 defect returned Hono's 404 here.
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "Unauthorized",
    });
  });

  it("serves DELETE /api/devices/:id via the Hono app (401 unauth, NOT 404)", async () => {
    const app = buildHonoApp();
    const res = await app.fetch(
      new Request("http://localhost/api/devices/some-device-id", {
        method: "DELETE",
      }),
      { trellisEnv: env },
    );
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "Unauthorized",
    });
  });
});
