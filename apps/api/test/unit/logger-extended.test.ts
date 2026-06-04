/**
 * Extended Unit Tests: Logger Adapter
 *
 * Edge-case tests for the trellis logger adapter.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getLogger } from "../../src/lib/logger.js";
import type { Logger } from "../../src/lib/logger.js";

describe("Logger adapter (extended)", () => {
  describe("Logger interface conformance", () => {
    it("implements all required methods", () => {
      const logger: Logger = getLogger();
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.trace).toBe("function");
    });
  });

  describe("data payload handling — no throw contract", () => {
    let logger: Logger;

    beforeEach(() => {
      logger = getLogger();
    });

    it("handles undefined data", () => {
      expect(() => logger.info("message")).not.toThrow();
    });

    it("handles Error data", () => {
      expect(() => logger.error("error message", new Error("boom"))).not.toThrow();
    });

    it("handles plain object data", () => {
      expect(() => logger.warn("warn", { key: "value" })).not.toThrow();
    });

    it("handles array data", () => {
      expect(() => logger.debug("debug", [1, 2, 3])).not.toThrow();
    });

    it("handles string primitive data", () => {
      expect(() => logger.trace("trace", "a string")).not.toThrow();
    });

    it("handles number primitive data", () => {
      expect(() => logger.info("count", 42)).not.toThrow();
    });

    it("handles boolean primitive data", () => {
      expect(() => logger.info("flag", true)).not.toThrow();
    });

    it("handles null data", () => {
      expect(() => logger.info("null", null)).not.toThrow();
    });

    it("handles deeply nested objects", () => {
      const deep = { a: { b: { c: { d: "value" } } } };
      expect(() => logger.info("deep", deep)).not.toThrow();
    });
  });
});
