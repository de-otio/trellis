/**
 * OpenAPI 3.1 Document Generator
 *
 * Introspects the trellis route registry to emit a valid OpenAPI 3.1 document.
 *
 * Progressive adoption (plan 034, lane B): every field below is optional on
 * `Route`, and a route that declares none of them keeps emitting exactly as
 * it always has — an empty `{}` request-body schema, no `security`, a
 * derived `operationId`. A route earns richer output by opting in:
 *
 *  - `requestSchema` / `responseSchema` (Zod) → a real, `$ref`-ed JSON Schema
 *    in `components.schemas`, named `<operationId>Request`/`Response`.
 *  - `scopes` → per-operation `security`. Three states, and the difference
 *    is load-bearing: **absent** omits the operation from this document
 *    entirely (first-party only; lane G enforces the same rule at mount
 *    time — this is only a preview of it); **`[]`** marks it
 *    authenticated-no-particular-scope (the bearer scheme); a **non-empty**
 *    list marks it oauth2-scoped.
 *  - `tags`, `operationId`, `stability` → carried through as declared,
 *    falling back to the existing derivation when absent.
 *
 * Because no real route in this repo sets `scopes` yet (lane A/G's job),
 * regenerating `openapi.snapshot.json` today yields a near-empty document —
 * expected and already flagged PROVISIONAL by
 * `scripts/check-openapi-additivity.mjs`. The document repopulates as real
 * routes adopt the fields above.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z, type ZodType } from "zod";
import type { Route } from "../routes/types.js";
import { CORE_SCOPES } from "../auth/scopes.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OpenApiDocument {
  openapi: "3.1.0";
  jsonSchemaDialect?: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

interface OpenApiPathItem {
  [method: string]: OpenApiOperation;
}

interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content: Record<string, { schema: unknown }>;
  };
  responses: Record<string, { description: string; content?: Record<string, { schema: unknown }> }>;
  tags?: string[];
  /** Present only when the operation is reachable at all — see module doc. */
  security?: Array<Record<string, string[]>>;
  /** Non-standard but harmless: carries `Route.stability` through verbatim. */
  "x-stability"?: "stable" | "beta";
}

interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: { type: string };
  description?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const API_TITLE = "Trellis API";
const API_VERSION_FALLBACK = "0.0.0";
const API_DESCRIPTION =
  "Social-network core API. Discovery surfaces, federation management (T3–T8), and entity/social graph endpoints.";
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Security scheme names emitted in `components.securitySchemes`. */
const OAUTH2_SCHEME = "oauth2";
const BEARER_SCHEME = "bearerAuth";

/** Methods that support a request body */
const BODY_METHODS = new Set(["post", "put", "patch"]);

/** Matches a still-positional path parameter placeholder, e.g. `{param0}`. */
const POSITIONAL_PARAM_RE = /\{param\d+\}/;

// Tags derived from path prefix for grouping
const FEDERATION_PREFIXES: [RegExp, string][] = [
  [/^\/api\/tenants\/[^/]+\/domains/, "tenant-domains"],
  [/^\/api\/tenants\/[^/]+\/identity-provider/, "tenant-idp"],
  [/^\/api\/tenants\/[^/]+\/members/, "tenant-members"],
  [/^\/api\/tenants\/[^/]+\/role-mappings/, "tenant-role-mappings"],
  [/^\/api\/tenants\/[^/]+\/audit/, "tenant-audit"],
  [/^\/api\/tenants/, "tenants"],
  [/^\/api\/auth\/discover/, "auth-discover"],
  [/^\/(llms\.txt|openapi\.json|security\.txt)/, "discovery"],
  [/^\/health/, "health"],
];

function deriveTag(path_: string): string {
  for (const [pattern, tag] of FEDERATION_PREFIXES) {
    if (pattern.test(path_)) return tag;
  }
  return "other";
}

// ── info.version ─────────────────────────────────────────────────────────────

/**
 * `apps/api/package.json` sits three directories above this module in both
 * layouts this file ships in: `src/lib/openapi/generator.ts` (tsx/vitest,
 * run directly against source) and `dist/lib/openapi/generator.js` (the
 * published tarball). Falls back to a placeholder rather than throwing —
 * a missing/unreadable package.json must not take `/openapi.json` down.
 */
function getPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? API_VERSION_FALLBACK;
  } catch {
    return API_VERSION_FALLBACK;
  }
}

// ── Path normalisation ─────────────────────────────────────────────────────────

/**
 * Convert a route pattern to an OpenAPI path string.
 *
 * Supports:
 *  - Exact strings: "/health" → "/health"
 *  - Express-style params: "/api/tenants/:id" → "/api/tenants/{id}"
 *  - Named-capture regex: /^\/api\/tenants\/(?<id>[^/]+)$/ →
 *    "/api/tenants/{id}"
 *  - Simple unnamed-capture regex: /^\/api\/tenants\/([^/]+)\/domains$/ →
 *    "/api/tenants/{param0}/domains" (kept for routes that don't need named
 *    params — see B.3's public-route enforcement in `generateOpenApiDoc`)
 *  - Wildcards and complex regex are skipped (returns null)
 */
export function routePatternToPath(pattern: Route["path"]): string | null {
  if (typeof pattern === "string") {
    if (pattern === "*") return null;
    // Convert express :param style
    return pattern.replace(/:([^/]+)/g, "{$1}");
  }

  if (pattern instanceof RegExp) {
    const src = pattern.source;
    // Skip wildcard-only patterns
    if (src === ".*" || src === "^.*$") return null;

    // Strip anchors
    let s = src.replace(/^\^/, "").replace(/\$$/, "");

    // Unescape forward slashes
    s = s.replace(/\\\//g, "/");

    // Replace capture groups with named or positional placeholders.
    // We walk character-by-character to correctly handle character classes
    // like `([^/]+)` which contain `]` that would fool a naive regex, and to
    // recognise a native JS named-capture prefix `(?<name>`.
    let paramIndex = 0;
    let result = "";
    let i = 0;
    while (i < s.length) {
      if (s[i] === "(") {
        const namedMatch = /^\(\?<([A-Za-z_$][\w$]*)>/.exec(s.slice(i));
        // Scan to the matching closing paren, skipping over [...] classes
        let depth = 1;
        i++;
        while (i < s.length && depth > 0) {
          if (s[i] === "[") {
            // Skip character class entirely
            i++;
            while (i < s.length && s[i] !== "]") i++;
            i++; // skip ']'
          } else if (s[i] === "(") {
            depth++;
            i++;
          } else if (s[i] === ")") {
            depth--;
            i++;
          } else {
            i++;
          }
        }
        result += namedMatch ? `{${namedMatch[1]}}` : `{param${paramIndex++}}`;
      } else {
        result += s[i];
        i++;
      }
    }
    s = result;

    // Bail out if any remaining regex metacharacters.
    // Note: {param0}/{name} placeholders are intentional OpenAPI path
    // parameters, so we only reject metacharacters that appear outside of
    // {...} placeholders.
    const withoutPlaceholders = s.replace(/\{[^}]+\}/g, "");
    if (/[.*+?^${}()|[\]\\]/.test(withoutPlaceholders)) return null;

    return s || null;
  }

  return null;
}

// ── Parameter extraction ───────────────────────────────────────────────────────

function extractPathParams(openApiPath: string): OpenApiParameter[] {
  const params: OpenApiParameter[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(openApiPath)) !== null) {
    params.push({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }
  return params;
}

// ── operationId ─────────────────────────────────────────────────────────────

function deriveOperationId(method: string, openApiPath: string): string {
  return `${method}_${openApiPath.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

// ── Zod → JSON Schema ────────────────────────────────────────────────────────

/**
 * `z.toJSONSchema` stamps a top-level `$schema` on every schema it produces.
 * That's correct for a standalone document but redundant (and slightly
 * unconventional) repeated on every entry of `components.schemas` — the
 * document already declares its dialect once via `jsonSchemaDialect`. Strip
 * it per component; everything else (including any `.meta({ example })`
 * the route declared) passes through untouched.
 */
function toComponentSchema(schema: ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = jsonSchema;
  return rest;
}

// ── Security ─────────────────────────────────────────────────────────────────

function buildSecuritySchemes(): Record<string, unknown> {
  return {
    [OAUTH2_SCHEME]: {
      type: "oauth2",
      description:
        "Third-party client access via the device authorization grant (RFC 8628): " +
        "POST /oauth2/device_authorization, the user approves at /agents/authorize, " +
        "the client polls POST /oauth2/token.",
      flows: {
        // OpenAPI 3.1's fixed oauth2 flow vocabulary (implicit, password,
        // clientCredentials, authorizationCode) has no native "device code"
        // entry for RFC 8628. `authorizationCode` is the closest fit —
        // `authorizationUrl` is where a human grants consent either way.
        authorizationCode: {
          authorizationUrl: "/agents/authorize",
          tokenUrl: "/oauth2/token",
          // Imported, not restated: `auth/scopes.ts` is the single source
          // of truth for the core scope catalog and its consent copy.
          scopes: { ...CORE_SCOPES },
        },
      },
    },
    [BEARER_SCHEME]: {
      type: "http",
      scheme: "bearer",
      description: "First-party session bearer token.",
    },
  };
}

/**
 * Derive per-operation `security` from `route.scopes`. Only called for
 * routes that have already passed the `scopes !== undefined` filter in
 * `generateOpenApiDoc` — an absent `scopes` omits the operation from the
 * document entirely rather than reaching this function.
 */
function buildSecurity(scopes: readonly string[]): Array<Record<string, string[]>> {
  if (scopes.length === 0) return [{ [BEARER_SCHEME]: [] }];
  return [{ [OAUTH2_SCHEME]: [...scopes] }];
}

// ── Request / response bodies ───────────────────────────────────────────────

function buildRequestBody(
  route: Route,
  operationId: string,
  schemas: Record<string, unknown>,
): OpenApiOperation["requestBody"] {
  if (route.requestSchema) {
    const schemaName = `${operationId}Request`;
    schemas[schemaName] = toComponentSchema(route.requestSchema);
    return {
      required: true,
      content: {
        "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } },
      },
    };
  }
  return {
    required: false,
    content: {
      "application/json": { schema: {} },
    },
  };
}

function buildResponses(
  route: Route,
  operationId: string,
  schemas: Record<string, unknown>,
): OpenApiOperation["responses"] {
  const responses: OpenApiOperation["responses"] = {
    "200": { description: "Success" },
    "400": { description: "Bad request" },
    "401": { description: "Unauthorized" },
    "500": { description: "Internal server error" },
  };

  if (route.responseSchema) {
    const schemaName = `${operationId}Response`;
    schemas[schemaName] = toComponentSchema(route.responseSchema);
    responses["200"] = {
      description: "Success",
      content: {
        "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } },
      },
    };
  }

  return responses;
}

// ── Operation builder ─────────────────────────────────────────────────────────

function buildOperation(
  route: Route,
  method: string,
  openApiPath: string,
  operationId: string,
  scopes: readonly string[],
  schemas: Record<string, unknown>,
): OpenApiOperation {
  const params = extractPathParams(openApiPath);
  const tags = route.tags && route.tags.length > 0 ? route.tags : [deriveTag(openApiPath)];

  const op: OpenApiOperation = {
    summary: route.description ?? `${method.toUpperCase()} ${openApiPath}`,
    operationId,
    tags,
    parameters: params.length > 0 ? params : undefined,
    responses: buildResponses(route, operationId, schemas),
    security: buildSecurity(scopes),
  };

  if (route.stability) {
    op["x-stability"] = route.stability;
  }

  if (BODY_METHODS.has(method)) {
    op.requestBody = buildRequestBody(route, operationId, schemas);
  }

  return op;
}

// ── Main generator ─────────────────────────────────────────────────────────────

/**
 * Generate an OpenAPI 3.1 document from the trellis route registry.
 *
 * A route appears in the document only if it passes every filter, in order:
 *
 * 1. `publicSpec === true` (G4 MEDIUM-3) — the curated agent-integration
 *    surface, not every registered handler.
 * 2. `scopes !== undefined` (plan 034 lane B / B.2) — a route that hasn't
 *    declared its scopes yet is first-party only and stays out of the
 *    public document. `[]` (authenticated, no particular scope) and any
 *    non-empty scope list both pass.
 * 3. The path pattern must convert to a representable OpenAPI path (wildcard
 *    handlers and complex regex are silently skipped, as before).
 *
 * A route that passes all three but still resolves to a *positional*
 * `{paramN}` placeholder (an unnamed regex capture group) fails the build —
 * see B.3: a route publish-worthy enough to reach the public document must
 * name its path parameters. Every `operationId` in the emitted document
 * (declared or derived) must also be unique; a collision fails the build too.
 */
export function generateOpenApiDoc(routes: Route[]): OpenApiDocument {
  const paths: Record<string, OpenApiPathItem> = {};
  const schemas: Record<string, unknown> = {};
  const seenOperationIds = new Map<string, string>();

  for (const route of routes) {
    if (route.publicSpec !== true) continue;
    if (route.scopes === undefined) continue;

    const openApiPath = routePatternToPath(route.path);
    if (!openApiPath) continue;

    if (POSITIONAL_PARAM_RE.test(openApiPath)) {
      throw new Error(
        `Public OpenAPI route "${openApiPath}" resolves a path parameter from an ` +
          `unnamed regex capture group ({param0}-style). Routes in the public document ` +
          `must name their path parameters — convert the capture group to a named one ` +
          `(e.g. "(?<id>[^/]+)") in the route module that registers this path.`,
      );
    }

    const scopes = route.scopes;
    const rawMethods = route.method ?? "GET";
    const methods = Array.isArray(rawMethods) ? rawMethods : [rawMethods];

    for (const rawMethod of methods) {
      if (rawMethod === "*") continue;
      const method = rawMethod.toLowerCase();

      const operationId = route.operationId ?? deriveOperationId(method, openApiPath);
      const collidesWith = seenOperationIds.get(operationId);
      if (collidesWith) {
        throw new Error(
          `Duplicate OpenAPI operationId "${operationId}": already emitted for ` +
            `${collidesWith}, also produced by ${method.toUpperCase()} ${openApiPath}. ` +
            `Set an explicit, unique \`operationId\` on one of these routes.`,
        );
      }
      seenOperationIds.set(operationId, `${method.toUpperCase()} ${openApiPath}`);

      if (!paths[openApiPath]) {
        paths[openApiPath] = {} as OpenApiPathItem;
      }

      paths[openApiPath][method] = buildOperation(route, method, openApiPath, operationId, scopes, schemas);
    }
  }

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    info: {
      title: API_TITLE,
      version: getPackageVersion(),
      description: API_DESCRIPTION,
    },
    paths,
    components: {
      schemas,
      securitySchemes: buildSecuritySchemes(),
    },
  };
}
