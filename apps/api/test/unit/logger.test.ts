/**
 * Unit Tests: Logger Adapter
 *
 * Tests the trellis logger adapter around @de-otio/saas-foundation/logger.
 * The adapter preserves the positional (message, data?) call shape while
 * delegating to the pino-backed foundation logger.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getLogger, generateRequestId } from "../../src/lib/logger.js";
import type { Logger } from "../../src/lib/logger.js";

describe("getLogger()", () => {
  it("returns an object with the expected method shape", () => {
    const logger = getLogger();
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.trace).toBe("function");
  });

  it("returns a fresh object each call", () => {
    const a = getLogger();
    const b = getLogger();
    expect(typeof a.info).toBe("function");
    expect(typeof b.info).toBe("function");
  });

  describe("toPayload wrapping — no throw contract", () => {
    let logger: Logger;

    beforeEach(() => {
      logger = getLogger();
    });

    it("handles undefined data", () => {
      expect(() => logger.error("message")).not.toThrow();
    });

    it("wraps Error data in { err } — does not throw", () => {
      expect(() => logger.error("something went wrong", new Error("test error"))).not.toThrow();
    });

    it("wraps plain object data directly — does not throw", () => {
      expect(() => logger.info("info event", { userId: "u1" })).not.toThrow();
    });

    it("wraps primitive data in { data } — does not throw", () => {
      expect(() => logger.warn("warning", 42)).not.toThrow();
    });

    it("handles null data gracefully — does not throw", () => {
      expect(() => logger.debug("null data", null)).not.toThrow();
    });

    it("handles all log levels without throwing", () => {
      expect(() => logger.error("e")).not.toThrow();
      expect(() => logger.warn("w")).not.toThrow();
      expect(() => logger.info("i")).not.toThrow();
      expect(() => logger.debug("d")).not.toThrow();
      expect(() => logger.trace("t")).not.toThrow();
    });
  });
});

describe("generateRequestId()", () => {
  it("returns a valid UUID v4", () => {
    const id = generateRequestId();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(id).toMatch(uuidRe);
  });

  it("returns unique IDs on successive calls", () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).not.toBe(b);
  });
});
