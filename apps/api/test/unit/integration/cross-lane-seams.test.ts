/**
 * Plan 034 lane H.1 — the seams no single lane owned.
 *
 * Every other test file in plan 034 was written by the lane that owns the code
 * it covers, so each one is correct about its own half and silent about the
 * join. This file only asserts things that are true of **two lanes at once**,
 * and it is deliberately table-driven rather than example-driven: an assertion
 * about one hand-named route stops being a seam test the moment a second route
 * is published.
 *
 * The four seams, and why each is here rather than in a lane file:
 *
 *  1. **One scope catalog, two consumers.** Lane 0 defines `CORE_SCOPES`,
 *     lane B emits it into `securitySchemes`, lane A/G's `requireScope`
 *     compares against strings routes declare. Nothing in a single lane can
 *     observe drift between them.
 *
 *  2. **Spec ⇔ enforcement equivalence.** Lane B emits `security`; lane G
 *     enforces `route.scopes`. A spec that promises a *narrower* scope than
 *     the code enforces tells an integration developer their token is safe
 *     when it is not — so this is asserted **behaviourally**, by driving the
 *     real dispatcher with a credential built from the emitted document, in
 *     both directions.
 *
 *  3. **Pipeline symmetry, and the one asymmetry.** Lane A's extension-route
 *     wrapper and lane G's public dispatcher run the same order. They differ
 *     on `auth: "optional"` + scopes, and the difference is pinned here rather
 *     than described in a comment.
 *
 *  4. **`ctx.events.emit` across the lane A/lane E join.** Lane E's emitter is
 *     tested in isolation and lane A's wrapper is tested without events; the
 *     composed behaviour — what an extension handler actually gets — belongs
 *     to neither.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { TrellisExtension } from "@de-otio/trellis-extension-api";
import { runWithTenantContext } from "@de-otio/saas-foundation/tenant";

import { routes, PUBLIC_API_PREFIX } from "../../../src/lib/routes/index.js";
import { generateOpenApiDoc } from "../../../src/lib/openapi/generator.js";
import { CORE_SCOPES } from "../../../src/lib/auth/scopes.js";
import { SessionManager } from "../../../src/lib/session-cookie.js";
import { createExtensionContext } from "../../../src/lib/extension-context.js";
import { mintTenantId } from "../../../src/lib/mint-tenant-id.js";
import { wrapExtensionRoute } from "../../../src/lib/extension-route-wrapper.js";
import type { Route } from "../../../src/lib/routes/types.js";
import type { Env } from "../../../src/env.js";

const SRC = join(import.meta.dirname, "../../../src");
const read = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

const env = {
  SESSION_SECRET: "test-secret-that-is-at-least-32-chars!!",
} as unknown as Env;

const doc = generateOpenApiDoc(routes);

/** One emitted operation, flattened with the route that serves it. */
interface Operation {
  readonly label: string;
  readonly path: string;
  readonly method: string;
  readonly advertised: readonly string[];
  readonly scheme: "oauth2" | "bearerAuth";
  readonly route: Route;
}

/** The `{param}` form the spec uses ← the `:param` form the router uses. */
function specPathOf(route: Route): string | null {
  if (typeof route.path !== "string") return null;
  return route.path.replace(/:([^/]+)/g, "{$1}");
}

const v1Routes = routes.filter(
  (r) => typeof r.path === "string" && r.path.startsWith(`${PUBLIC_API_PREFIX}/`),
);

const operations: Operation[] = Object.entries(doc.paths).flatMap(([path, item]) =>
  Object.entries(item as Record<string, { security?: Array<Record<string, string[]>> }>)
    .filter(([method]) => method !== "parameters")
    .map(([method, op]) => {
      const route = v1Routes.find((r) => {
        const p = specPathOf(r);
        if (p !== path) return false;
        const declared = r.method ?? "GET";
        const list = Array.isArray(declared) ? declared : [declared];
        return list.some((m) => m.toLowerCase() === method);
      });
      if (!route) {
        throw new Error(
          `Spec emits ${method.toUpperCase()} ${path} but no /api/v1 route serves it. ` +
            `(public-mount.test.ts owns the path-level version of this check; this ` +
            `is the method-level one, which the operation walk below depends on.)`,
        );
      }
      const requirement = op.security?.[0] ?? {};
      const scheme = ("oauth2" in requirement ? "oauth2" : "bearerAuth") as
        | "oauth2"
        | "bearerAuth";
      return {
        label: `${method.toUpperCase()} ${path}`,
        path,
        method,
        advertised: requirement[scheme] ?? [],
        scheme,
        route,
      };
    }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Seam 1 — one scope catalog, two consumers (lane 0 → lane B, lane 0 → lane A)
// ═══════════════════════════════════════════════════════════════════════════

describe("one scope catalog, two consumers", () => {
  const catalog = (
    doc.components!.securitySchemes!.oauth2 as {
      flows: { authorizationCode: { scopes: Record<string, string> } };
    }
  ).flows.authorizationCode.scopes;

  it("emits the core catalog verbatim — the generator imports it, never restates it", () => {
    // Lane B asserts this too (`openapi/generator.test.ts`). It is repeated
    // here because it is the premise everything below rests on: if the spec's
    // catalog were a copy, every equivalence in this file would be comparing
    // a copy to itself.
    expect(catalog).toEqual(CORE_SCOPES);
    expect(read("lib/openapi/generator.ts")).toMatch(/scopes:\s*\{\s*\.\.\.CORE_SCOPES\s*\}/);
  });

  it("declares every scope any route in the live table asks for", () => {
    // The drift this catches: a route module inventing `post:write` (singular)
    // or `posts.write` (the capability separator). `hasScope` compares by
    // exact string equality, so such a scope is unsatisfiable by any grant a
    // consent screen built from this catalog could produce — the route would
    // be permanently 403 and the spec would not say why.
    const declared = new Set(Object.keys(catalog));
    const unknown = routes
      .flatMap((r) => (Array.isArray(r.scopes) ? r.scopes : []))
      .filter((s) => !declared.has(s));
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("advertises no scope on an operation that the catalog does not define", () => {
    const declared = new Set(Object.keys(catalog));
    for (const op of operations) {
      expect(
        op.advertised.filter((s) => !declared.has(s)),
        `${op.label} advertises a scope absent from securitySchemes`,
      ).toEqual([]);
    }
  });

  it("RECORDED GAP: an extension's own scopes reach `security` but not `securitySchemes`", () => {
    // `buildSecuritySchemes()` emits `{...CORE_SCOPES}` and nothing else,
    // while `buildSecurity()` copies whatever the route declared. An extension
    // route publishing `dogs:read` therefore produces a document whose
    // operation references a scope its own `oauth2` scheme never defines —
    // invalid per OpenAPI 3.1 §4.8.29.2, and a consent screen generated from
    // the scheme could not offer the scope the operation demands.
    //
    // Recorded, not fixed: `lib/openapi/generator.ts` is lane B's file and
    // nothing publishes an extension route yet (plan 034 README §"Do not pivot
    // on blockers"). This test pins the CURRENT behaviour so the day the
    // generator learns extension catalogs, it fails here and is inverted
    // deliberately rather than drifting silently.
    const ext: TrellisExtension = {
      id: "dog",
      terminology: { entity: "dog", entityPlural: "dogs" },
      routes: [],
      metadataSchema: z.object({}),
      extensionRoutes: [
        {
          path: "walks",
          method: "GET",
          scopes: ["walks:read"],
          publicSpec: true,
          operationId: "listWalks",
          handle: async () => ({ status: 200, body: {} }),
        },
      ],
    } as unknown as TrellisExtension;

    const wrapped = wrapExtensionRoute(ext, ext.extensionRoutes![0]);
    const described: Route = {
      ...wrapped,
      path: "/api/v1/ext/dog/walks",
      scopes: ["walks:read"],
      publicSpec: true,
      operationId: "listWalks",
    };
    const extDoc = generateOpenApiDoc([described]);

    const op = (extDoc.paths["/api/v1/ext/dog/walks"] as Record<string, { security: Array<Record<string, string[]>> }>).get;
    expect(op.security).toEqual([{ oauth2: ["walks:read"] }]);

    const extCatalog = (
      extDoc.components!.securitySchemes!.oauth2 as {
        flows: { authorizationCode: { scopes: Record<string, string> } };
      }
    ).flows.authorizationCode.scopes;
    expect(Object.keys(extCatalog)).not.toContain("walks:read");
    expect(extCatalog).toEqual(CORE_SCOPES);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Seam 2 — spec ⇔ enforcement equivalence (lane B ↔ lane G)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Drive the real dispatcher with a session holding exactly `granted` and
 * report whether the **scope gate** rejected it.
 *
 * Anything past the gate counts as "passed": a 500, a thrown handler, an
 * idempotency-store failure. That is deliberate — the claim under test is
 * about the gate, and pinning it to a 200 would make the test a test of every
 * handler's dependencies instead.
 */
async function gateRejects(
  op: Operation,
  granted: ReadonlySet<string> | "*",
): Promise<{ rejected: boolean; missing: readonly string[] }> {
  const url = new URL(`https://api.example.com${op.path.replace(/\{[^}]+\}/g, "x")}`);
  const request = new Request(url.toString(), {
    method: op.method.toUpperCase(),
    ...(op.method === "get" || op.method === "head"
      ? {}
      : { body: "{}", headers: { "content-type": "application/json" } }),
  });

  vi.spyOn(SessionManager.prototype, "getSession").mockResolvedValue({
    userId: "u_seam",
    clientId: "client_seam",
    scopes: granted,
  } as never);

  let response: Response;
  try {
    response = await op.route.handler(request, env, {
      url,
      pathname: url.pathname,
      params: {},
    } as never);
  } catch {
    // The dispatcher converts InsufficientScopeError into a 403 and rethrows
    // nothing else from the gate, so a throw is necessarily downstream of it.
    return { rejected: false, missing: [] };
  }

  if (response.status !== 403) return { rejected: false, missing: [] };
  const body = (await response.json()) as { error?: string; message?: string };
  if (body.error !== "INSUFFICIENT_SCOPE") return { rejected: false, missing: [] };
  return {
    rejected: true,
    missing: [...(body.message ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]),
  };
}

describe("what the spec advertises is exactly what the dispatcher enforces", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("has operations to walk — an empty walk proves nothing", () => {
    expect(operations.length).toBeGreaterThan(0);
  });

  it("names every published operation, so a reviewer can see the coverage", () => {
    // Snapshot-free on purpose: the assertion is that the list is non-empty
    // and printable, not that it is a particular list (that is
    // public-mount.test.ts's "the public surface is exactly …").
    expect(operations.map((o) => `${o.label} → ${o.scheme}:[${o.advertised.join(",")}]`))
      .toMatchInlineSnapshot(`
      [
        "GET /api/v1/users/me/tenants → oauth2:[tenant:read]",
      ]
    `);
  });

  for (const op of operations) {
    describe(op.label, () => {
      it("is not enforced MORE narrowly than it advertises — the advertised grant suffices", async () => {
        // The direction an integration developer notices immediately: they
        // requested exactly what the document asked for and still got a 403.
        const { rejected, missing } = await gateRejects(op, new Set(op.advertised));
        expect(rejected, `${op.label} rejected a credential holding ${JSON.stringify(op.advertised)}; missing ${JSON.stringify(missing)}`).toBe(false);
      });

      it("is not enforced LESS narrowly than it advertises — every advertised scope is load-bearing", async () => {
        // **The dangerous direction.** A spec promising a narrower scope than
        // the code enforces is worse than no spec; its mirror image — the spec
        // listing a scope the code never checks — tells a developer their
        // token is *more* constrained than it is. Both are caught by removing
        // each advertised scope in turn and requiring a 403 that names it.
        for (const scope of op.advertised) {
          const granted = new Set(op.advertised.filter((s) => s !== scope));
          const { rejected, missing } = await gateRejects(op, granted);
          expect(rejected, `${op.label} accepted a credential missing \`${scope}\``).toBe(true);
          expect(missing, `${op.label}'s 403 does not name \`${scope}\``).toContain(scope);
        }
      });

      it("declares in code the same scopes it advertises in the document", () => {
        // The static half. Redundant with the two behavioural tests today and
        // cheap insurance if a future dispatcher grows a second scope source.
        expect(new Set(op.route.scopes ?? [])).toEqual(new Set(op.advertised));
      });

      it("uses the oauth2 scheme iff it asks for a scope", () => {
        expect(op.scheme).toBe(op.advertised.length === 0 ? "bearerAuth" : "oauth2");
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Seam 3 — pipeline order, and the one place the two mounts disagree
// ═══════════════════════════════════════════════════════════════════════════

describe("lane A's wrapper and lane G's dispatcher run the same pipeline", () => {
  const wrapper = read("lib/extension-route-wrapper.ts");
  const dispatcher = read("lib/routes/index.ts");

  it("orders scope BEFORE body validation in both, for the same stated reason", () => {
    // Order is structural, so it is asserted structurally: in each file the
    // `requireScope` call must precede the request-body validation call.
    const wrapScope = wrapper.indexOf("requireScope(session,");
    const wrapValidate = wrapper.indexOf("await validateRequestBody(");
    expect(wrapScope).toBeGreaterThan(-1);
    expect(wrapValidate).toBeGreaterThan(wrapScope);

    const dispScope = dispatcher.indexOf("requireScope(session,");
    const dispValidate = dispatcher.indexOf("validatePublicRequestBody(route,");
    expect(dispScope).toBeGreaterThan(-1);
    expect(dispValidate).toBeGreaterThan(dispScope);
  });

  it("keeps rate limiting ahead of the whole handler in both, as route middleware", () => {
    // Both lanes decided the limiter stays where it already was — outside
    // `handler`, so an unauthenticated flood is limited before it reaches
    // authentication. Neither moved it inward to match the prose order.
    expect(wrapper).toMatch(/middleware\.push\(rateLimitMiddleware\(\)\)/);
    expect(dispatcher).not.toMatch(/rateLimitMiddleware\(\)/);
  });

  it("ASYMMETRY: `auth: \"optional\"` + scopes fails closed on /api/v1 and fails OPEN on /api/ext", () => {
    // Lane G recorded this and closed it for core routes only: its dispatcher
    // returns 401 before the gate, because `requireScope` reads an absent
    // principal as first-party `"*"`. The wrapper cannot take that route — an
    // `auth: "optional"` extension route is *meant* to serve anonymous callers
    // — so it guards the gate with `if (session && ...)` and an anonymous
    // caller reaches `handle()` with the declared scopes unchecked.
    //
    // Not a defect of either lane in isolation; it is what "optional" means on
    // each side. It is a defect *of the pair* if an extension author reads the
    // core rule and assumes it holds for their route, which is why it is
    // pinned here.
    expect(wrapper).toMatch(/if \(session && routeDef\.scopes\)/);
    expect(dispatcher).toMatch(/if \(!session\) return unauthorizedError\(/);

    // …and the same declaration is refused outright once it is public: an
    // extension route with `publicSpec` cannot be `auth: "none"`, because the
    // /api/v1 mount would authenticate it anyway.
    expect(dispatcher).toMatch(/declares publicSpec: true \` \+\s*\`with auth: "none"/);
  });

  it("refuses scopes on a route that can never have a principal, in both", () => {
    expect(wrapper).toMatch(/authLevel === "none" && routeDef\.scopes/);
    expect(dispatcher).toMatch(/route\.scopes !== undefined && route\.scopes\.length > 0 && route\.publicSpec !== true/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Seam 3b — lane C's idempotency rule has exactly one production call site
// ═══════════════════════════════════════════════════════════════════════════

describe("routeNeedsIdempotency is applied where lane C intended and nowhere else", () => {
  const files = [
    "lib/routes/index.ts",
    "lib/extension-route-wrapper.ts",
    "lib/middleware/idempotency.ts",
    "lib/app.ts",
  ];

  it("is invoked from exactly one production call site", () => {
    // Plan 034's file-ownership table anticipated TWO call sites (lane A for
    // extension routes, lane G for core routes). Lane G's public mount
    // collapsed them into one: an extension route that declares
    // `publicSpec` + `scopes` is mounted under /api/v1 through the *same*
    // dispatcher, so it reaches the same rule through the same call. One call
    // site is the stronger outcome and this test is what keeps it at one — a
    // second copy of the rule is how the two mounts start disagreeing about
    // which writes are replay-protected.
    // Invocations only: the `export function routeNeedsIdempotency(` in lane
    // C's own file is the declaration, not a use of the rule.
    const callSites = files.flatMap((f) =>
      [...read(f).matchAll(/(?<![.\w])(?<decl>function\s+)?routeNeedsIdempotency\s*\(/g)]
        .filter((m) => !m.groups?.decl)
        .map(() => f),
    );
    expect(callSites).toEqual(["lib/routes/index.ts"]);
  });

  it("leaves the unversioned /api/ext path without replay protection, deliberately", () => {
    // The consequence of one call site, stated so it is a decision and not a
    // surprise: an extension write served at `/api/ext/<id>/<path>` is NOT
    // idempotency-protected; only its `/api/v1/ext/<id>/<path>` alias is. The
    // unversioned path is the first-party surface, which has never had replay
    // protection; the public one is the contract a third party integrates
    // against.
    expect(read("lib/extension-route-wrapper.ts")).not.toContain("idempotency");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Seam 4 — ctx.events.emit across the lane A / lane E join
// ═══════════════════════════════════════════════════════════════════════════

describe("ctx.events.emit, as an extension route actually receives it", () => {
  const OWN = mintTenantId("tenant_own", "session");

  function recordingPrisma() {
    const rows: Array<Record<string, unknown>> = [];
    return {
      rows,
      prisma: {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            domainEvent: {
              create: async ({ data }: { data: Record<string, unknown> }) => {
                rows.push(data);
                return { id: `de_${rows.length}`, ...data };
              },
            },
          }),
      } as never,
    };
  }

  const ext = {
    id: "dog",
    terminology: { entity: "dog", entityPlural: "dogs" },
    routes: [],
    metadataSchema: z.object({}),
  } as unknown as TrellisExtension;

  const extEnv = {
    APP_DOMAIN: "example.com",
    APP_URL: "https://api.example.com",
    STAGE: "dev",
    SESSION_SECRET: "super-secret-do-not-expose-to-extensions!!",
  } as never;

  it("is built by the wrapper WITHOUT the request's tenant — five arguments, not six", () => {
    // The join, read off the source: `resolveTenantId()` runs *after*
    // `createExtensionContext(...)` in `wrapExtensionRoute`, so the tenant the
    // wrapper resolves for `ExtensionSession.tenantId` is not the tenant the
    // emitter closes over. Lane E left the sixth parameter open for exactly
    // this and lane A did not fill it — neither lane could see the gap from
    // inside its own file set.
    const wrapper = read("lib/extension-route-wrapper.ts");
    expect(wrapper).toContain(
      "createExtensionContext(ext, env, prisma, graph, callerRegion)",
    );
    expect(wrapper.indexOf("createExtensionContext(")).toBeLessThan(
      wrapper.indexOf("await resolveTenantId(session, prisma)"),
    );
  });

  it("therefore FAILS CLOSED on a default deployment — TENANT_SCOPE_MODE is off", async () => {
    // With no tenant passed, the emitter falls back to the ambient tenant
    // context. That context is established by `lib/app.ts` only when
    // `TENANT_SCOPE_MODE !== "off"`, and "off" is the documented default
    // (`lib/tenant-scope.ts`). So on a stock deployment an extension calling
    // `ctx.events.emit` gets a throw, which the wrapper's catch turns into a
    // 500 with `{"error":"Internal server error"}`.
    //
    // Acceptable for 0.10.0 — nothing reads the outbox, no shipped extension
    // emits, and the failure is loud rather than a row scoped to nothing — but
    // it is NOT what `ExtensionContext.events`' published doc comment says
    // ("The emitter is bound to the tenant core resolved for the caller").
    // Recorded as an H.1 finding; the fix is one argument in lane A's file.
    expect(process.env.TENANT_SCOPE_MODE ?? "off").toBe("off");

    const db = recordingPrisma();
    const ctx = createExtensionContext(ext, extEnv, db.prisma, undefined, "EU");

    await expect(ctx.events.emit("walk.created", { walkId: "w_1" })).rejects.toThrow(
      /no active tenant/,
    );
    expect(db.rows).toEqual([]);
  });

  it("succeeds the moment an ambient tenant exists — the seam itself is wired", () => {
    // The other half of the finding: the composition is correct, only the
    // tenant source is missing. Under the ambient context the wrapper's
    // five-argument call produces a working emitter, so enabling tenant
    // scoping (or passing the sixth argument) is the whole fix.
    const db = recordingPrisma();
    const ctx = createExtensionContext(ext, extEnv, db.prisma, undefined, "EU");

    return runWithTenantContext(OWN, async () => {
      await ctx.events.emit("walk.created", { walkId: "w_1" });
      expect(db.rows[0]).toMatchObject({
        type: "walk.created",
        tenantId: "tenant_own",
        subjectKind: "extension",
        subjectId: "dog",
      });
    });
  });

  it("is required, not optional — `ctx.events.emit(...)` needs no `?.`", () => {
    // Lane E promoted `ExtensionContext.events` from `events?` to `events`.
    // The published snapshot is the contract; assert against it rather than
    // against the source, because the snapshot is what an extension author's
    // typechecker reads.
    const snapshot = readFileSync(
      join(import.meta.dirname, "../../../../../packages/extension-api/etc/public-api.snapshot.d.ts"),
      "utf8",
    );
    expect(snapshot).toMatch(/^\s*events: ExtensionEventEmitter;/m);
    expect(snapshot).not.toMatch(/^\s*events\?: ExtensionEventEmitter;/m);
  });
});
