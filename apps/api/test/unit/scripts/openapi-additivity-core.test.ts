/**
 * Unit tests: OpenAPI additivity classifier (pure module).
 *
 * Exercises all seven contract rules (plan §2.3 / §4-T2) against SYNTHETIC
 * OpenAPI-shaped fixtures. Four of the seven (response field removed, field
 * type changed, required-request-field added, enum value removed) are
 * dormant on the real generator's output today (it emits empty `{}`
 * schemas) — that's exactly why they're tested here against fixtures that
 * carry real schema detail, per the classifier module's header comment.
 */

import { describe, expect, it } from "vitest";
import { classify } from "../../../scripts/openapi-additivity-core.mjs";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function baseDoc(paths: Record<string, unknown>) {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths,
  };
}

function op(overrides: Record<string, unknown> = {}) {
  return {
    responses: { "200": { description: "ok" } },
    ...overrides,
  };
}

describe("classify", () => {
  // ── Rule 1: path removed ─────────────────────────────────────────────────
  it("flags a removed path as BREAKING", () => {
    const oldDoc = baseDoc({ "/a": { get: op() }, "/b": { get: op() } });
    const newDoc = baseDoc({ "/a": { get: op() } });

    const { breaking } = classify(oldDoc, newDoc);

    expect(breaking.some((f) => f.rule === "path-removed" && f.path === "/b")).toBe(true);
  });

  it("flags a new path as an addition, not breaking", () => {
    const oldDoc = baseDoc({ "/a": { get: op() } });
    const newDoc = baseDoc({ "/a": { get: op() }, "/c": { get: op() } });

    const { breaking, additions } = classify(oldDoc, newDoc);

    expect(breaking).toHaveLength(0);
    expect(additions.some((f) => f.rule === "path-added" && f.path === "/c")).toBe(true);
  });

  // ── Rule 2: method removed ───────────────────────────────────────────────
  it("flags a removed method as BREAKING", () => {
    const oldDoc = baseDoc({ "/a": { get: op(), post: op() } });
    const newDoc = baseDoc({ "/a": { get: op() } });

    const { breaking } = classify(oldDoc, newDoc);

    expect(breaking.some((f) => f.rule === "method-removed" && f.method === "post")).toBe(true);
  });

  it("flags a new method as an addition", () => {
    const oldDoc = baseDoc({ "/a": { get: op() } });
    const newDoc = baseDoc({ "/a": { get: op(), post: op() } });

    const { breaking, additions } = classify(oldDoc, newDoc);

    expect(breaking).toHaveLength(0);
    expect(additions.some((f) => f.rule === "method-added" && f.method === "post")).toBe(true);
  });

  // ── Rule 3: parameter removed or made required ──────────────────────────
  it("flags a removed parameter as BREAKING", () => {
    const oldDoc = baseDoc({
      "/a/{id}": { get: op({ parameters: [{ name: "id", in: "path", required: true }] }) },
    });
    const newDoc = baseDoc({ "/a/{id}": { get: op({ parameters: [] }) } });

    const { breaking } = classify(oldDoc, newDoc);

    expect(breaking.some((f) => f.rule === "parameter-removed")).toBe(true);
  });

  it("flags a parameter newly made required as BREAKING", () => {
    const oldDoc = baseDoc({
      "/a": { get: op({ parameters: [{ name: "q", in: "query", required: false }] }) },
    });
    const newDoc = baseDoc({
      "/a": { get: op({ parameters: [{ name: "q", in: "query", required: true }] }) },
    });

    const { breaking } = classify(oldDoc, newDoc);

    expect(breaking.some((f) => f.rule === "parameter-made-required")).toBe(true);
  });

  it("treats relaxing a required parameter to optional as an addition", () => {
    const oldDoc = baseDoc({
      "/a": { get: op({ parameters: [{ name: "q", in: "query", required: true }] }) },
    });
    const newDoc = baseDoc({
      "/a": { get: op({ parameters: [{ name: "q", in: "query", required: false }] }) },
    });

    const { breaking, additions } = classify(oldDoc, newDoc);

    expect(breaking).toHaveLength(0);
    expect(additions.some((f) => f.rule === "parameter-relaxed")).toBe(true);
  });

  it("treats a new optional parameter as an addition", () => {
    const oldDoc = baseDoc({ "/a": { get: op({ parameters: [] }) } });
    const newDoc = baseDoc({
      "/a": { get: op({ parameters: [{ name: "q", in: "query", required: false }] }) },
    });

    const { breaking, additions } = classify(oldDoc, newDoc);

    expect(breaking).toHaveLength(0);
    expect(additions.some((f) => f.rule === "parameter-added")).toBe(true);
  });

  // ── Rule 4: response field removed ──────────────────────────────────────
  it("flags a removed response field as BREAKING", () => {
    const oldDoc = baseDoc({
      "/a": {
        get: op({
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
                },
              },
            },
          },
        }),
      },
    });
    const newDoc = baseDoc({
      "/a": {
        get: op({
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { id: { type: "string" } } },
                },
              },
            },
          },
        }),
      },
    });

    const { breaking } = classify(oldDoc, newDoc);

    expect(
      breaking.some((f) => f.rule === "field-removed" && f.path.endsWith(".name")),
    ).toBe(true);
  });

  it("treats a new response field as an addition", () => {
    const schemaWith = (props: Record<string, unknown>) => ({
      "200": {
        description: "ok",
        content: { "application/json": { schema: { type: "object", properties: props } } },
      },
    });
    const oldDoc = baseDoc({ "/a": { get: op({ responses: schemaWith({ id: { type: "string" } }) }) } });
    const newDoc = baseDoc({
      "/a": {
        get: op({
          responses: schemaWith({ id: { type: "string" }, extra: { type: "string" } }),
        }),
      },
    });

    const { breaking, additions } = classify(oldDoc, newDoc);

    expect(breaking).toHaveLength(0);
    expect(additions.some((f) => f.rule === "field-added" && f.path.endsWith(".extra"))).toBe(true);
  });

  // ── Rule 5: field type changed ───────────────────────────────────────────
  it("flags a field type change as BREAKING", () => {
    const responsesWith = (type: string) => ({
      "200": {
        description: "ok",
        content: {
          "application/json": { schema: { type: "object", properties: { count: { type } } } },
        },
      },
    });
    const oldDoc = baseDoc({ "/a": { get: op({ responses: responsesWith("integer") }) } });
    const newDoc = baseDoc({ "/a": { get: op({ responses: responsesWith("string") }) } });

    const { breaking } = classify(oldDoc, newDoc);

    expect(breaking.some((f) => f.rule === "field-type-changed" && f.path.endsWith(".count"))).toBe(true);
  });

  // ── Rule 6: required request-body field added ────────────────────────────
  it("flags a newly required request-body field as BREAKING", () => {
    const requestBodyWith = (required: string[]) => ({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { name: { type: "string" }, email: { type: "string" } },
            required,
          },
        },
      },
    });
    const oldDoc = baseDoc({ "/a": { post: op({ requestBody: requestBodyWith(["name"]) }) } });
    const newDoc = baseDoc({ "/a": { post: op({ requestBody: requestBodyWith(["name", "email"]) }) } });

    const { breaking } = classify(oldDoc, newDoc);

    expect(
      breaking.some((f) => f.rule === "required-field-added" && f.path.endsWith(".email")),
    ).toBe(true);
  });

  it("treats relaxing a required request-body field to optional as an addition", () => {
    const requestBodyWith = (required: string[]) => ({
      required: true,
      content: {
        "application/json": {
          schema: { type: "object", properties: { name: { type: "string" } }, required },
        },
      },
    });
    const oldDoc = baseDoc({ "/a": { post: op({ requestBody: requestBodyWith(["name"]) }) } });
    const newDoc = baseDoc({ "/a": { post: op({ requestBody: requestBodyWith([]) }) } });

    const { breaking, additions } = classify(oldDoc, newDoc);

    expect(breaking).toHaveLength(0);
    expect(additions.some((f) => f.rule === "required-field-relaxed")).toBe(true);
  });

  // ── Rule 7: enum value removed ────────────────────────────────────────────
  it("flags a removed enum value as BREAKING", () => {
    const responsesWith = (values: string[]) => ({
      "200": {
        description: "ok",
        content: {
          "application/json": {
            schema: { type: "object", properties: { status: { type: "string", enum: values } } },
          },
        },
      },
    });
    const oldDoc = baseDoc({ "/a": { get: op({ responses: responsesWith(["active", "archived"]) }) } });
    const newDoc = baseDoc({ "/a": { get: op({ responses: responsesWith(["active"]) }) } });

    const { breaking } = classify(oldDoc, newDoc);

    expect(breaking.some((f) => f.rule === "enum-value-removed")).toBe(true);
  });

  it("treats a new enum value as an addition", () => {
    const responsesWith = (values: string[]) => ({
      "200": {
        description: "ok",
        content: {
          "application/json": {
            schema: { type: "object", properties: { status: { type: "string", enum: values } } },
          },
        },
      },
    });
    const oldDoc = baseDoc({ "/a": { get: op({ responses: responsesWith(["active"]) }) } });
    const newDoc = baseDoc({ "/a": { get: op({ responses: responsesWith(["active", "pending"]) }) } });

    const { breaking, additions } = classify(oldDoc, newDoc);

    expect(breaking).toHaveLength(0);
    expect(additions.some((f) => f.rule === "enum-value-added")).toBe(true);
  });

  // ── Boundary / failure-path cases ─────────────────────────────────────────
  it("returns no findings for two identical empty documents", () => {
    const doc = baseDoc({});
    const { breaking, additions } = classify(doc, doc);
    expect(breaking).toHaveLength(0);
    expect(additions).toHaveLength(0);
  });

  it("tolerates a missing paths object on either side without throwing", () => {
    expect(() => classify({}, {})).not.toThrow();
    expect(() => classify(baseDoc({ "/a": { get: op() } }), {})).not.toThrow();
  });

  it("flags a removed response status as BREAKING", () => {
    const oldDoc = baseDoc({
      "/a": { get: op({ responses: { "200": { description: "ok" }, "404": { description: "nf" } } }) },
    });
    const newDoc = baseDoc({ "/a": { get: op({ responses: { "200": { description: "ok" } } }) } });

    const { breaking } = classify(oldDoc, newDoc);

    expect(breaking.some((f) => f.rule === "response-removed")).toBe(true);
  });

  it("flags a removed nested array-item field as BREAKING", () => {
    const responsesWith = (props: Record<string, unknown>) => ({
      "200": {
        description: "ok",
        content: {
          "application/json": {
            schema: { type: "array", items: { type: "object", properties: props } },
          },
        },
      },
    });
    const oldDoc = baseDoc({
      "/a": { get: op({ responses: responsesWith({ id: { type: "string" }, name: { type: "string" } }) }) },
    });
    const newDoc = baseDoc({
      "/a": { get: op({ responses: responsesWith({ id: { type: "string" } }) }) },
    });

    const { breaking } = classify(oldDoc, newDoc);

    expect(breaking.some((f) => f.rule === "field-removed" && f.path.includes("[].name"))).toBe(true);
  });
});
