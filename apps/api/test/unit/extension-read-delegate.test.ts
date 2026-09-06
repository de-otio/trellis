/**
 * Unit tests: extension-read-delegate.ts — `buildReadOnlyFacade`.
 *
 * The claim under test is the runtime restriction, not just the type: a raw
 * Prisma delegate also carries create/update/delete/…, so this facade must
 * expose EXACTLY the five read methods and nothing the caller's `resolve`
 * did not explicitly wire up — including refusing to silently install a
 * dangerous method under a read-method NAME, and failing closed when a
 * method is missing rather than installing `undefined`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildReadOnlyFacade,
  READ_DELEGATE_METHODS,
} from "../../src/lib/extension-read-delegate.js";

describe("READ_DELEGATE_METHODS", () => {
  it("is exactly the five read methods, in this order", () => {
    expect(READ_DELEGATE_METHODS).toEqual([
      "findMany",
      "findFirst",
      "count",
      "aggregate",
      "groupBy",
    ]);
  });
});

describe("buildReadOnlyFacade", () => {
  function rawDelegate() {
    return {
      findMany: vi.fn().mockResolvedValue(["a"]),
      findFirst: vi.fn().mockResolvedValue("a"),
      count: vi.fn().mockResolvedValue(1),
      aggregate: vi.fn().mockResolvedValue({ _count: 1 }),
      groupBy: vi.fn().mockResolvedValue([]),
      // Dangerous methods a raw Prisma delegate also carries.
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    };
  }

  it("exposes exactly the five read methods bound to the raw delegate", async () => {
    const raw = rawDelegate();
    const facade = buildReadOnlyFacade((m) => (raw as any)[m].bind(raw), "test");
    expect(Object.keys(facade).sort()).toEqual([...READ_DELEGATE_METHODS].sort());
    await (facade as any).findMany();
    expect(raw.findMany).toHaveBeenCalledTimes(1);
  });

  it("create/update/delete/deleteMany are UNREACHABLE on the facade — not merely absent from the type", () => {
    const raw = rawDelegate();
    const facade = buildReadOnlyFacade((m) => (raw as any)[m].bind(raw), "test");
    for (const dangerous of ["create", "update", "delete", "deleteMany"]) {
      expect((facade as any)[dangerous]).toBeUndefined();
    }
  });

  it("the facade is frozen — assigning a new method to it is a no-op / throws in strict mode", () => {
    "use strict";
    const raw = rawDelegate();
    const facade = buildReadOnlyFacade((m) => (raw as any)[m].bind(raw), "test");
    expect(Object.isFrozen(facade)).toBe(true);
    expect(() => {
      (facade as any).deleteMany = raw.deleteMany;
    }).toThrow();
  });

  it("has a null prototype — no inherited Object.prototype surface (hasOwnProperty, __proto__, …)", () => {
    const raw = rawDelegate();
    const facade = buildReadOnlyFacade((m) => (raw as any)[m].bind(raw), "test");
    expect(Object.getPrototypeOf(facade)).toBeNull();
    expect((facade as any).hasOwnProperty).toBeUndefined();
  });

  it("fails closed (throws) when `resolve` returns something that is not a function", () => {
    expect(() =>
      buildReadOnlyFacade((m) => (m === "findMany" ? undefined : vi.fn()), "widget"),
    ).toThrow(TypeError);
    expect(() =>
      buildReadOnlyFacade((m) => (m === "count" ? undefined : vi.fn()), "widget"),
    ).toThrow(/\[widget\] read delegate is missing method: count/);
  });

  it("calls `resolve` for every one of the five methods, even after an early one succeeds", () => {
    const resolve = vi.fn((_m: string) => vi.fn());
    buildReadOnlyFacade(resolve, "widget");
    expect(resolve).toHaveBeenCalledTimes(5);
    for (const m of READ_DELEGATE_METHODS) {
      expect(resolve).toHaveBeenCalledWith(m);
    }
  });

  it("does not fabricate a read method under a name resolve was never asked to provide", () => {
    const raw = rawDelegate();
    const facade = buildReadOnlyFacade((m) => (raw as any)[m].bind(raw), "test");
    expect("create" in facade).toBe(false);
  });
});
