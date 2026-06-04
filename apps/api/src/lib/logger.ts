/**
 * Trellis-side adapter around `@de-otio/saas-foundation/logger`.
 *
 * Foundation owns the runtime logger (pino-backed, structured,
 * AsyncLocalStorage-aware). Trellis call-sites use a positional-arg
 * shape — `logger.error("message", data)` — that pre-dates the
 * cutover. This module preserves that shape so the cutover stays
 * mechanical (a 400-site singleton-call → `getLogger()` codemod,
 * nothing more) while delegating to foundation underneath.
 *
 * When foundation's request-context module is in scope (i.e. inside
 * `runWithRequestContext`), `getLogger()` resolves to the
 * request-scoped logger that carries `requestId`/`tenantId`/etc.
 * outside scope, it returns foundation's root logger. Hardening
 * the entrypoint set so every getLogger() call has an active
 * RequestContext is a follow-up — keeping the fallback today
 * avoids a 400-site coordination problem.
 */

import {
  getLogger as getFoundationLogger,
  type Logger as FoundationLogger,
} from "@de-otio/saas-foundation/logger";

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";

export interface LoggerEnv {
  LOG_LEVEL?: string;
  NODE_ENV?: string;
}

/**
 * Trellis logger shape — positional `(message, data?)` calls.
 * Internally delegates to foundation's pino-style logger; `data`,
 * when present, is wrapped into a structured payload (`{ err }` for
 * Error instances, the object itself for plain objects, `{ data }`
 * for primitives).
 */
export interface Logger {
  error(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
  trace(message: string, data?: unknown): void;
}

type FoundationLevel = "error" | "warn" | "info" | "debug" | "trace";

function toPayload(data: unknown): object {
  if (data instanceof Error) return { err: data };
  if (typeof data === "object" && data !== null) return data;
  return { data };
}

function wrap(level: FoundationLevel): (message: string, data?: unknown) => void {
  return (message, data) => {
    const fl: FoundationLogger = getFoundationLogger();
    if (data === undefined) {
      fl[level](message);
    } else {
      fl[level](toPayload(data), message);
    }
  };
}

/**
 * Get a request-scoped logger. Returns the foundation root logger
 * when called outside a `runWithRequestContext` scope (the same
 * fallback shape the singleton `getLogger()` provided).
 */
export function getLogger(): Logger {
  return {
    error: wrap("error"),
    warn: wrap("warn"),
    info: wrap("info"),
    debug: wrap("debug"),
    trace: wrap("trace"),
  };
}

/**
 * Generate a unique request ID for log correlation. Used by code
 * paths that need a stable correlator before a RequestContext exists.
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}
