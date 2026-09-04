/**
 * Unit tests: the OpenAPI additivity gate, exercised end-to-end against the
 * REAL generator (`generateOpenApiDoc`) rather than hand-written JSON
 * fixtures — proving plan 034 lane B's B.4 acceptance criteria:
 *
 *  - the four previously-dormant classifier rules (response field removed,
 *    field type changed, required-request-field added, enum value removed)
 *    now fire against real generator output for a route carrying a real
 *    Zod schema;
 *  - the gate stays green when the document is regenerated unchanged;
 *  - a deliberately-broken fixture (a field removed from a real response
 *    schema) makes it red;
 *  - the new 8th rule — adding a required scope is BREAKING, removing one
 *    is additive — fires correctly.
 *
 * The pure classifier itself (`classify`) is unit-tested exhaustively
 * against synthetic fixtures in
 * `test/unit/scripts/openapi-additivity-core.test.ts`; this file is the
 * "does it actually wake up against the real generator" proof.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateOpenApiDoc } from "../../../src/lib/openapi/generator.js";
import { classify } from "../../../scripts/openapi-additivity-core.mjs";
import type { Route } from "../../../src/lib/routes/types.js";

function makeRoute(overrides: Partial<Route> & { path: Route["path"] }): Route {
  return {
    method: "GET",
    handler: async () => new Response("ok"),
    publicSpec: true,
    scopes: [],
    ...overrides,
  };
}

describe("openapi additivity gate — real generator output", () => {
  it("stays green when the document is regenerated unchanged", () => {
    const responseSchema = z.object({ id: z.string(), title: z.string() });
    const routes: Route[] = [
      makeRoute({ path: "/api/widgets/:id", method: "GET", operationId: "getWidget", responseSchema }),
    ];
    const doc = generateOpenApiDoc(routes);

    const { breaking, additions } = classify(doc, doc);

    expect(breaking).toHaveLength(0);
    expect(additions).toHaveLength(0);
  });

  it("goes red (rule 4, response field removed) when a field is deliberately dropped from a real response schema", () => {
    const oldSchema = z.object({ id: z.string(), title: z.string() });
    const newSchema = z.object({ id: z.string() }); // "title" deliberately removed

    const oldDoc = generateOpenApiDoc([
      makeRoute({ path: "/api/widgets/:id", method: "GET", operationId: "getWidget", responseSchema: oldSchema }),
    ]);
    const newDoc = generateOpenApiDoc([
      makeRoute({ path: "/api/widgets/:id", method: "GET", operationId: "getWidget", responseSchema: newSchema }),
    ]);

    const { breaking } = classify(oldDoc, newDoc);

    expect(breaking.some((f) => f.rule === "field-removed" && f.path.endsWith(".title"))).toBe(true);
  });

  it("goes red (rule 5, field type changed) when a real response field's type changes", () => {
    const oldSchema = z.object({ count: z.number() });
    const newSchema = z.object({ count: z.string() });

    const oldDoc = generateOpenApiDoc([
      makeRoute({ path: "/api/counts", method: "GET", operationId: "getCounts", responseSchema: oldSchema }),
    ]);
    const newDoc = generateOpenApiDoc([
      makeRoute({ path: "/api/counts", method: "GET", operationId: "getCounts", responseSchema: newSchema }),
    ]);

    const { breaking } = classify(oldDoc, newDoc);

    expect(breaking.some((f) => f.rule === "field-type-changed" && f.path.endsWith(".count"))).toBe(true);
  });

  it("goes red (rule 6, required request-body field added) when a real request schema tightens", () => {
    const oldSchema = z.object({ name: z.string(), email: z.string().optional() });
    const newSchema = z.object({ name: z.string(), email: z.string() });

    const oldDoc = generateOpenApiDoc([
      makeRoute({ path: "/api/signup", method: "POST", operationId: "signup", requestSchema: oldSchema }),
    ]);
    const newDoc = generateOpenApiDoc([
      makeRoute({ path: "/api/signup", method: "POST", operationId: "signup", requestSchema: newSchema }),
    ]);

    const { breaking } = classify(oldDoc, newDoc);

    expect(
      breaking.some((f) => f.rule === "required-field-added" && f.path.endsWith(".email")),
    ).toBe(true);
  });

  it("goes red (rule 7, enum value removed) when a real response enum narrows", () => {
    const oldSchema = z.object({ status: z.enum(["active", "archived"]) });
    const newSchema = z.object({ status: z.enum(["active"]) });

    const oldDoc = generateOpenApiDoc([
      makeRoute({ path: "/api/items", method: "GET", operationId: "getItem", responseSchema: oldSchema }),
    ]);
    const newDoc = generateOpenApiDoc([
      makeRoute({ path: "/api/items", method: "GET", operationId: "getItem", responseSchema: newSchema }),
    ]);

    const { breaking } = classify(oldDoc, newDoc);

    expect(breaking.some((f) => f.rule === "enum-value-removed")).toBe(true);
  });

  it("flags adding a required scope as BREAKING", () => {
    const oldDoc = generateOpenApiDoc([
      makeRoute({ path: "/api/widgets", method: "GET", operationId: "listWidgets", scopes: ["entities:read"] }),
    ]);
    const newDoc = generateOpenApiDoc([
      makeRoute({
        path: "/api/widgets",
        method: "GET",
        operationId: "listWidgets",
        scopes: ["entities:read", "posts:read"],
      }),
    ]);

    const { breaking } = classify(oldDoc, newDoc);

    expect(
      breaking.some((f) => f.rule === "scope-added" && f.detail.includes("posts:read")),
    ).toBe(true);
  });

  it("flags removing a scope as additive, not breaking", () => {
    const oldDoc = generateOpenApiDoc([
      makeRoute({ path: "/api/widgets", method: "GET", operationId: "listWidgets", scopes: ["entities:read"] }),
    ]);
    const newDoc = generateOpenApiDoc([
      makeRoute({ path: "/api/widgets", method: "GET", operationId: "listWidgets", scopes: [] }),
    ]);

    const { breaking, additions } = classify(oldDoc, newDoc);

    expect(breaking).toHaveLength(0);
    expect(
      additions.some((f) => f.rule === "scope-removed" && f.detail.includes("entities:read")),
    ).toBe(true);
  });

  it("flags a route losing its scope declaration entirely as a path removal (dropped from the public document)", () => {
    // scopes going from declared to undeclared doesn't just relax security —
    // the B.2 filter drops the operation out of the document altogether,
    // which the classifier correctly reports as the operation's path/method
    // disappearing (a stronger, and correctly BREAKING, signal).
    const oldDoc = generateOpenApiDoc([
      makeRoute({ path: "/api/widgets", method: "GET", operationId: "listWidgets", scopes: [] }),
    ]);
    const newDoc = generateOpenApiDoc([
      { path: "/api/widgets", method: "GET", handler: async () => new Response("ok"), publicSpec: true },
    ]);

    const { breaking } = classify(oldDoc, newDoc);

    expect(breaking.some((f) => f.rule === "path-removed")).toBe(true);
  });
});
