/**
 * Database Circuit Breaker
 *
 * Circuit breaker for database operations. Prevents retry storms during
 * database outages by failing fast after a threshold of consecutive
 * failures, then probing for recovery after a cooldown.
 *
 * Internals are backed by `cockatiel`'s circuit-breaker policy
 * (ConsecutiveBreaker). This module is a thin trellis-flavoured adapter
 * that preserves the original public surface — `execute`, `getState`,
 * `getFailureCount`, `reset`, and the `CircuitBreakerState` string union —
 * so existing/future call-sites stay source-compatible.
 *
 * States (trellis surface):
 * - CLOSED:    Normal operation, requests pass through.
 * - OPEN:      Too many failures, requests fail immediately.
 * - HALF_OPEN: cockatiel is running a single probe call to test recovery.
 *              Note: in cockatiel HALF_OPEN is transient — it is only
 *              observable *during* the probe execution, not as a resting
 *              state between calls (unlike the previous hand-rolled
 *              implementation). cockatiel governs half-open probing itself:
 *              a single probe is permitted once `cooldownMs` has elapsed.
 */

import {
  BrokenCircuitError,
  CircuitBreakerPolicy,
  CircuitState,
  ConsecutiveBreaker,
  circuitBreaker,
  handleAll,
} from "cockatiel";
import { Logger } from "./logger.js";

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /**
   * Number of consecutive failures before opening the circuit.
   * Default: 3. Maps to cockatiel `new ConsecutiveBreaker(n)`.
   */
  failureThreshold?: number;

  /**
   * Cooldown period in milliseconds before the circuit allows a recovery
   * probe (transition OPEN -> HALF_OPEN).
   * Default: 30000 (30 seconds). Maps to cockatiel `halfOpenAfter`.
   */
  cooldownMs?: number;
}

function toState(state: CircuitState): CircuitBreakerState {
  switch (state) {
    case CircuitState.Closed:
      return "CLOSED";
    case CircuitState.HalfOpen:
      return "HALF_OPEN";
    // Open and the manually-held Isolated state both block execution.
    case CircuitState.Open:
    case CircuitState.Isolated:
    default:
      return "OPEN";
  }
}

export class DatabaseCircuitBreaker {
  private policy: CircuitBreakerPolicy;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private logger?: Logger;

  /**
   * Consecutive-failure count, mirrored from cockatiel's breaker via its
   * success/failure events. cockatiel does not expose the running count,
   * so we track it ourselves to preserve `getFailureCount()`.
   */
  private failures = 0;

  constructor(options: CircuitBreakerOptions = {}, logger?: Logger) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30000; // 30 seconds
    this.logger = logger;
    this.policy = this.buildPolicy();
  }

  /**
   * Construct a fresh cockatiel circuit-breaker policy and wire the
   * count-mirroring + logging hooks. Used by the constructor and by
   * `reset()` (cockatiel has no public force-close on an open breaker).
   */
  private buildPolicy(): CircuitBreakerPolicy {
    const policy = circuitBreaker(handleAll, {
      halfOpenAfter: this.cooldownMs,
      breaker: new ConsecutiveBreaker(this.failureThreshold),
    });

    // Mirror cockatiel's internal consecutive-failure count so the trellis
    // surface can report it. onFailure fires per failed execution; onSuccess
    // fires per successful execution.
    policy.onFailure(() => {
      this.failures++;
    });
    policy.onSuccess(() => {
      this.failures = 0;
    });

    // Logger hooks (parity with the previous implementation's log points).
    policy.onBreak(() => {
      this.logger?.warn(
        "[DatabaseCircuitBreaker] Circuit OPENED (too many failures)",
        {
          failures: this.failures,
          threshold: this.failureThreshold,
        },
      );
    });
    policy.onHalfOpen(() => {
      this.logger?.info(
        "[DatabaseCircuitBreaker] Circuit entering HALF_OPEN state (recovery probe)",
        {
          cooldownMs: this.cooldownMs,
        },
      );
    });
    policy.onReset(() => {
      this.failures = 0;
      this.logger?.info("[DatabaseCircuitBreaker] Circuit CLOSED (recovered)");
    });

    return policy;
  }

  /**
   * Execute a function with circuit breaker protection.
   *
   * When the circuit is open, throws an Error whose message begins with
   * "Circuit breaker is OPEN" (translated from cockatiel's
   * BrokenCircuitError) to preserve the previous error contract.
   */
  async execute<T>(
    fn: () => Promise<T>,
    context?: { operation?: string; region?: string; [key: string]: any },
  ): Promise<T> {
    try {
      return await this.policy.execute(() => fn());
    } catch (error: unknown) {
      if (error instanceof BrokenCircuitError) {
        this.logger?.warn(
          "[DatabaseCircuitBreaker] Request blocked (circuit OPEN)",
          {
            state: this.getState(),
            failures: this.failures,
            ...context,
          },
        );
        throw new Error(
          "Circuit breaker is OPEN (too many failures). " +
            `Cooldown: ${Math.ceil(this.cooldownMs / 1000)}s`,
        );
      }
      throw error;
    }
  }

  /**
   * Get current circuit breaker state (mapped to the trellis string union).
   */
  getState(): CircuitBreakerState {
    return toState(this.policy.state);
  }

  /**
   * Get current consecutive-failure count.
   */
  getFailureCount(): number {
    return this.failures;
  }

  /**
   * Whether the circuit is currently blocking execution (OPEN/Isolated).
   */
  isOpen(): boolean {
    return this.getState() === "OPEN";
  }

  /**
   * Manually reset the circuit breaker to a fresh CLOSED policy.
   *
   * cockatiel has no public "force close" on an open breaker, so reset
   * rebuilds the policy. This restores the previous `reset()` semantics
   * (CLOSED, zero failures) used by tests/debugging.
   */
  reset(): void {
    this.failures = 0;
    this.policy = this.buildPolicy();
    this.logger?.info("[DatabaseCircuitBreaker] Circuit manually reset");
  }
}
