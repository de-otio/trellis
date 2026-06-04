/**
 * Extension-API contract tests (Stage 4).
 *
 * In-process, no server/infra. Locks the TrellisExtension contract using the
 * dummy-target fixtures, so a breaking change to the extension API fails here
 * — before publish — rather than downstream in a consuming vertical.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { validateExtensions } from "../../src/lib/extension-validator.js";
import {
  exampleExtension,
  minimalExtension,
  hookCalls,
  resetHookCalls,
} from "../fixtures/example-extension/index.js";

describe("extension contract: validateExtensions", () => {
  it("accepts the full and minimal reference extensions", () => {
    expect(() =>
      validateExtensions([exampleExtension, minimalExtension]),
    ).not.toThrow();
  });

  it("rejects a reserved id", () => {
    const ext = { ...minimalExtension, id: "admin" };
    expect(() => validateExtensions([ext])).toThrow(/reserved/i);
  });

  it("rejects an invalid id format (uppercase / too short)", () => {
    expect(() =>
      validateExtensions([{ ...minimalExtension, id: "X" }]),
    ).toThrow(/lowercase|2-32/i);
    expect(() =>
      validateExtensions([{ ...minimalExtension, id: "Widget" }]),
    ).toThrow(/lowercase|2-32/i);
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      validateExtensions([minimalExtension, { ...minimalExtension }]),
    ).toThrow(/duplicate/i);
  });

  it("rejects routes that shadow a reserved core prefix", () => {
    const ext = {
      ...minimalExtension,
      id: "shadower",
      routes: [
        {
          path: "/api/admin/steal",
          method: "GET",
          handler: async () => new Response(null),
        },
      ],
    };
    expect(() => validateExtensions([ext as any])).toThrow(/reserved prefix/i);
  });
});

describe("extension contract: metadataSchema", () => {
  it("the example schema accepts valid metadata", () => {
    const r = exampleExtension.metadataSchema.safeParse({
      color: "blue",
      size: "m",
    });
    expect(r.success).toBe(true);
  });

  it("the example schema rejects an out-of-enum size", () => {
    const r = exampleExtension.metadataSchema.safeParse({
      color: "blue",
      size: "xl",
    });
    expect(r.success).toBe(false);
  });

  it("the example schema rejects missing required fields and unknown keys", () => {
    expect(exampleExtension.metadataSchema.safeParse({ color: "blue" }).success).toBe(
      false,
    );
    expect(
      exampleExtension.metadataSchema.safeParse({
        color: "blue",
        size: "m",
        rogue: 1,
      }).success,
    ).toBe(false); // .strict()
  });

  it("the minimal schema accepts arbitrary object metadata", () => {
    expect(
      minimalExtension.metadataSchema.safeParse({ anything: true }).success,
    ).toBe(true);
  });
});

describe("extension contract: optional surfaces", () => {
  it("computeLifeStage derives a value from metadata", () => {
    expect(exampleExtension.computeLifeStage?.({ size: "l" }, false, null)).toBe(
      "mature",
    );
    expect(exampleExtension.computeLifeStage?.({ size: "m" }, false, null)).toBeNull();
  });

  it("relationshipSignalProvider returns a blendable signal", async () => {
    const signal = await exampleExtension.relationshipSignalProvider?.computeSignal(
      "u1",
      "u2",
      "user",
      { currentScore: 0.1, tier: 1 },
    );
    expect(signal).toBe(0.5);
  });

  it("activityPub.enrichActor returns display-only fields", () => {
    const a = exampleExtension.activityPub?.enrichActor?.({
      name: "Spinny",
      metadata: { color: "red" },
    });
    expect(a?.summary).toContain("Spinny");
    expect(a?.attachment?.[0]).toMatchObject({ name: "Color", value: "red" });
  });

  it("declares entity relationship types and discovery facets", () => {
    expect(exampleExtension.entityRelationshipTypes).toContain("LINKED_TO");
    expect(exampleExtension.discoveryFacets?.[0]).toMatchObject({
      field: "color",
      type: "exact",
    });
  });
});

describe("extension contract: hooks & lifecycle", () => {
  const ctx: any = { appDomain: "localhost", appUrl: "http://localhost", stage: "test", config: {}, db: {} };

  beforeEach(() => resetHookCalls());

  it("init and shutdown fire and record in order", async () => {
    await exampleExtension.init?.(ctx);
    await exampleExtension.shutdown?.();
    const order = hookCalls.map((c) => c.hook);
    expect(order.indexOf("init")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("shutdown")).toBeGreaterThan(order.indexOf("init"));
  });

  it("onEntityCreated / onPostCreated record their payloads", async () => {
    await exampleExtension.hooks?.onEntityCreated?.({ id: "e1" }, ctx);
    await exampleExtension.hooks?.onPostCreated?.({ id: "p1" }, ctx);
    expect(hookCalls.map((c) => c.hook)).toEqual([
      "onEntityCreated",
      "onPostCreated",
    ]);
    expect(hookCalls[0].args[0]).toMatchObject({ id: "e1" });
  });
});
