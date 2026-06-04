/**
 * Unit Tests: Database Circuit Breaker
 *
 * The breaker is backed by cockatiel's ConsecutiveBreaker circuit-breaker
 * policy. These tests assert OUTCOMES against cockatiel semantics:
 *   - opens after N consecutive failures
 *   - fails fast (rejects without running fn) while open
 *   - after the cooldown, permits a single recovery probe (HALF_OPEN)
 *   - probe success closes the circuit; probe failure re-opens it
 *   - a success resets the consecutive-failure count
 *
 * Note on HALF_OPEN: unlike a hand-rolled breaker, cockatiel does not sit
 * in a resting HALF_OPEN state between calls. HALF_OPEN is only entered for
 * the duration of the probe execution, so it is asserted via the probe's
 * behaviour (it runs, and its outcome drives the transition) rather than by
 * inspecting getState() between calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseCircuitBreaker } from "../../src/lib/database-circuit-breaker.js";
import { getLogger } from "../../src/lib/logger.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("DatabaseCircuitBreaker", () => {
  let circuitBreaker: DatabaseCircuitBreaker;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (circuitBreaker) {
      circuitBreaker.reset();
    }
  });

  describe("Initialization", () => {
    it("should initialize with CLOSED state", () => {
      circuitBreaker = new DatabaseCircuitBreaker();
      expect(circuitBreaker.getState()).toBe("CLOSED");
      expect(circuitBreaker.getFailureCount()).toBe(0);
    });

    it("should use default options", () => {
      circuitBreaker = new DatabaseCircuitBreaker();
      expect(circuitBreaker.getState()).toBe("CLOSED");
    });

    it("should accept custom options", () => {
      circuitBreaker = new DatabaseCircuitBreaker({
        failureThreshold: 5,
        cooldownMs: 60000,
        halfOpenTimeoutMs: 120000,
      });
      expect(circuitBreaker.getState()).toBe("CLOSED");
    });

    it("should accept logger", () => {
      circuitBreaker = new DatabaseCircuitBreaker({}, getLogger());
      expect(circuitBreaker.getState()).toBe("CLOSED");
    });
  });

  describe("CLOSED State", () => {
    beforeEach(() => {
      circuitBreaker = new DatabaseCircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 100, // Short cooldown for testing
      });
    });

    it("should execute successful operations", async () => {
      const result = await circuitBreaker.execute(async () => "success");
      expect(result).toBe("success");
      expect(circuitBreaker.getState()).toBe("CLOSED");
      expect(circuitBreaker.getFailureCount()).toBe(0);
    });

    it("should track failures but remain CLOSED below threshold", async () => {
      await expect(
        circuitBreaker.execute(async () => {
          throw new Error("Test error 1");
        }),
      ).rejects.toThrow("Test error 1");
      expect(circuitBreaker.getState()).toBe("CLOSED");
      expect(circuitBreaker.getFailureCount()).toBe(1);

      await expect(
        circuitBreaker.execute(async () => {
          throw new Error("Test error 2");
        }),
      ).rejects.toThrow("Test error 2");
      expect(circuitBreaker.getState()).toBe("CLOSED");
      expect(circuitBreaker.getFailureCount()).toBe(2);
    });

    it("should reset failure count on success", async () => {
      await expect(
        circuitBreaker.execute(async () => {
          throw new Error("Test error");
        }),
      ).rejects.toThrow();
      await expect(
        circuitBreaker.execute(async () => {
          throw new Error("Test error");
        }),
      ).rejects.toThrow();
      expect(circuitBreaker.getFailureCount()).toBe(2);

      // Success resets the consecutive-failure count
      await circuitBreaker.execute(async () => "success");
      expect(circuitBreaker.getFailureCount()).toBe(0);
    });
  });

  describe("OPEN State", () => {
    beforeEach(() => {
      circuitBreaker = new DatabaseCircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 100,
      });
    });

    const openCircuit = async () => {
      for (let i = 0; i < 3; i++) {
        await expect(
          circuitBreaker.execute(async () => {
            throw new Error("Test error");
          }),
        ).rejects.toThrow();
      }
    };

    it("should open circuit after threshold consecutive failures", async () => {
      await openCircuit();
      expect(circuitBreaker.getState()).toBe("OPEN");
      expect(circuitBreaker.getFailureCount()).toBe(3);
    });

    it("should block (fail fast) requests when OPEN without running fn", async () => {
      await openCircuit();

      const fn = vi.fn(async () => "should not execute");
      await expect(circuitBreaker.execute(fn)).rejects.toThrow(
        "Circuit breaker is OPEN",
      );
      // Fail-fast: the wrapped function must not have been invoked.
      expect(fn).not.toHaveBeenCalled();
    });

    it("should log when blocking requests", async () => {
      const logger = getLogger();
      const warnSpy = vi.spyOn(logger, "warn");
      const cb = new DatabaseCircuitBreaker(
        { failureThreshold: 3, cooldownMs: 100 },
        logger,
      );

      for (let i = 0; i < 3; i++) {
        await expect(
          cb.execute(async () => {
            throw new Error("Test error");
          }),
        ).rejects.toThrow();
      }

      await expect(
        cb.execute(async () => "should not execute", {
          operation: "test",
          region: "EU",
        }),
      ).rejects.toThrow("Circuit breaker is OPEN");

      expect(warnSpy).toHaveBeenCalledWith(
        "[DatabaseCircuitBreaker] Request blocked (circuit OPEN)",
        expect.objectContaining({ operation: "test", region: "EU" }),
      );
      cb.reset();
    });
  });

  describe("HALF_OPEN / Recovery", () => {
    beforeEach(() => {
      circuitBreaker = new DatabaseCircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 50, // Short cooldown for testing
      });
    });

    const openCircuit = async () => {
      for (let i = 0; i < 3; i++) {
        await expect(
          circuitBreaker.execute(async () => {
            throw new Error("Test error");
          }),
        ).rejects.toThrow();
      }
    };

    it("should permit a recovery probe after the cooldown", async () => {
      await openCircuit();
      expect(circuitBreaker.getState()).toBe("OPEN");

      // Before cooldown elapses: still fails fast.
      const blocked = vi.fn(async () => "nope");
      await expect(circuitBreaker.execute(blocked)).rejects.toThrow(
        "Circuit breaker is OPEN",
      );
      expect(blocked).not.toHaveBeenCalled();

      // After cooldown: the probe is allowed to run.
      await sleep(60);
      const probe = vi.fn(async () => "success");
      const result = await circuitBreaker.execute(probe);
      expect(result).toBe("success");
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it("should close the circuit on a successful probe", async () => {
      await openCircuit();
      await sleep(60);

      await circuitBreaker.execute(async () => "success");
      expect(circuitBreaker.getState()).toBe("CLOSED");
      expect(circuitBreaker.getFailureCount()).toBe(0);
    });

    it("should re-open the circuit on a failed probe", async () => {
      await openCircuit();
      await sleep(60);

      await expect(
        circuitBreaker.execute(async () => {
          throw new Error("Probe failure");
        }),
      ).rejects.toThrow("Probe failure");
      expect(circuitBreaker.getState()).toBe("OPEN");

      // And it fails fast again immediately after the failed probe.
      const blocked = vi.fn(async () => "nope");
      await expect(circuitBreaker.execute(blocked)).rejects.toThrow(
        "Circuit breaker is OPEN",
      );
      expect(blocked).not.toHaveBeenCalled();
    });
  });

  describe("State Transitions", () => {
    beforeEach(() => {
      circuitBreaker = new DatabaseCircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 50,
      });
    });

    it("should transition CLOSED -> OPEN -> (probe) -> CLOSED", async () => {
      expect(circuitBreaker.getState()).toBe("CLOSED");

      for (let i = 0; i < 2; i++) {
        await expect(
          circuitBreaker.execute(async () => {
            throw new Error("Test error");
          }),
        ).rejects.toThrow();
      }
      expect(circuitBreaker.getState()).toBe("OPEN");

      await sleep(60);

      // Successful probe closes the circuit.
      await circuitBreaker.execute(async () => "success");
      expect(circuitBreaker.getState()).toBe("CLOSED");
    });
  });

  describe("Logging", () => {
    it("should log circuit opening", async () => {
      const logger = getLogger();
      const warnSpy = vi.spyOn(logger, "warn");
      circuitBreaker = new DatabaseCircuitBreaker(
        { failureThreshold: 3, cooldownMs: 100 },
        logger,
      );

      for (let i = 0; i < 3; i++) {
        await expect(
          circuitBreaker.execute(async () => {
            throw new Error("Test error");
          }),
        ).rejects.toThrow();
      }

      expect(warnSpy).toHaveBeenCalledWith(
        "[DatabaseCircuitBreaker] Circuit OPENED (too many failures)",
        expect.objectContaining({ threshold: 3 }),
      );
    });

    it("should log circuit closing on recovery", async () => {
      const logger = getLogger();
      const infoSpy = vi.spyOn(logger, "info");
      circuitBreaker = new DatabaseCircuitBreaker(
        { failureThreshold: 3, cooldownMs: 50 },
        logger,
      );

      for (let i = 0; i < 3; i++) {
        await expect(
          circuitBreaker.execute(async () => {
            throw new Error("Test error");
          }),
        ).rejects.toThrow();
      }

      await sleep(60);
      await circuitBreaker.execute(async () => "success");

      expect(infoSpy).toHaveBeenCalledWith(
        "[DatabaseCircuitBreaker] Circuit CLOSED (recovered)",
      );
    });
  });

  describe("Reset", () => {
    beforeEach(() => {
      circuitBreaker = new DatabaseCircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 100,
      });
    });

    it("should reset circuit breaker to initial state", async () => {
      for (let i = 0; i < 2; i++) {
        await expect(
          circuitBreaker.execute(async () => {
            throw new Error("Test error");
          }),
        ).rejects.toThrow();
      }
      expect(circuitBreaker.getState()).toBe("OPEN");
      expect(circuitBreaker.getFailureCount()).toBe(2);

      circuitBreaker.reset();
      expect(circuitBreaker.getState()).toBe("CLOSED");
      expect(circuitBreaker.getFailureCount()).toBe(0);
    });

    it("should allow operations after reset", async () => {
      for (let i = 0; i < 2; i++) {
        await expect(
          circuitBreaker.execute(async () => {
            throw new Error("Test error");
          }),
        ).rejects.toThrow();
      }

      circuitBreaker.reset();

      const result = await circuitBreaker.execute(async () => "success");
      expect(result).toBe("success");
      expect(circuitBreaker.getState()).toBe("CLOSED");
    });
  });
});
