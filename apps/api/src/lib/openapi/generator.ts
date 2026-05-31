/**
 * OpenAPI 3.1 Document Generator
 *
 * Introspects the trellis route registry to emit a valid OpenAPI 3.1 document.
 * Coverage priority: federation endpoints (T3–T8) plus the discovery surface.
 * For routes whose Zod schemas aren't directly accessible, minimal `{}` schemas
 * are emitted — validity over richness.
 */

import type { Route } from "../routes/types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description?: string;
  };
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, unknown>;
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
const API_VERSION = "0.7.0";
const API_DESCRIPTION =
  "Social-network core API. Discovery surfaces, federation management (T3–T8), and entity/social graph endpoints.";

/** Methods that support a request body */
const BODY_METHODS = new Set(["post", "put", "patch"]);

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

function deriveTag(path: string): string {
  for (const [pattern, tag] of FEDERATION_PREFIXES) {
    if (pattern.test(path)) return tag;
  }
  return "other";
}

// ── Path normalisation ─────────────────────────────────────────────────────────

/**
 * Convert a route pattern to an OpenAPI path string.
 *
 * Supports:
 *  - Exact strings: "/health" → "/health"
 *  - Express-style params: "/api/tenants/:id" → "/api/tenants/{id}"
 *  - Simple named-group regex: /^\/api\/tenants\/([^/]+)\/domains$/ →
 *    "/api/tenants/{param0}/domains"
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

    // Replace capture groups with positional placeholders.
    // We walk character-by-character to correctly handle character classes
    // like `([^/]+)` which contain `]` that would fool a naive regex.
    let paramIndex = 0;
    let result = "";
    let i = 0;
    while (i < s.length) {
      if (s[i] === "(") {
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
        result += `{param${paramIndex++}}`;
      } else {
        result += s[i];
        i++;
      }
    }
    s = result;

    // Bail out if any remaining regex metacharacters.
    // Note: {param0} placeholders are intentional OpenAPI path parameters, so
    // we only reject metacharacters that appear outside of {...} placeholders.
    const withoutPlaceholders = s.replace(/\{param\d+\}/g, "");
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

// ── Operation builder ─────────────────────────────────────────────────────────

function buildOperation(
  route: Route,
  method: string,
  openApiPath: string,
): OpenApiOperation {
  const params = extractPathParams(openApiPath);
  const tag = deriveTag(openApiPath);

  const op: OpenApiOperation = {
    summary: route.description ?? `${method.toUpperCase()} ${openApiPath}`,
    operationId: `${method}_${openApiPath.replace(/[^a-zA-Z0-9]/g, "_")}`,
    tags: [tag],
    parameters: params.length > 0 ? params : undefined,
    responses: {
      "200": { description: "Success" },
      "400": { description: "Bad request" },
      "401": { description: "Unauthorized" },
      "500": { description: "Internal server error" },
    },
  };

  if (BODY_METHODS.has(method)) {
    op.requestBody = {
      required: false,
      content: {
        "application/json": { schema: {} },
      },
    };
  }

  return op;
}

// ── Main generator ─────────────────────────────────────────────────────────────

/**
 * Generate an OpenAPI 3.1 document from the trellis route registry.
 *
 * Hardening (G4 MEDIUM-3): the generator emits ONLY routes flagged
 * `publicSpec: true`. Routes without the flag (posts, comments, media,
 * ActivityPub, extension-defined routes, etc.) are excluded so the
 * public spec is a curated agent-integration surface rather than a
 * reflection of every registered handler.
 *
 * Routes that cannot be represented as OpenAPI paths (wildcard handlers,
 * complex regex) are silently skipped.
 */
export function generateOpenApiDoc(routes: Route[]): OpenApiDocument {
  const paths: Record<string, OpenApiPathItem> = {};

  for (const route of routes) {
    if (route.publicSpec !== true) continue;
    const openApiPath = routePatternToPath(route.path);
    if (!openApiPath) continue;

    const rawMethods = route.method ?? "GET";
    const methods = Array.isArray(rawMethods) ? rawMethods : [rawMethods];

    for (const rawMethod of methods) {
      if (rawMethod === "*") continue;
      const method = rawMethod.toLowerCase();

      if (!paths[openApiPath]) {
        paths[openApiPath] = {} as OpenApiPathItem;
      }

      paths[openApiPath][method] = buildOperation(route, method, openApiPath);
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: API_TITLE,
      version: API_VERSION,
      description: API_DESCRIPTION,
    },
    paths,
    components: {
      schemas: {},
    },
  };
}
