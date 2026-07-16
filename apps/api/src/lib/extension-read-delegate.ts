/**
 * Shared read-only delegate primitive for the two cross-tenant extension
 * surfaces: the jobs `read` facade (own models, O-1) and routes/strategies'
 * `discover()` facade (declared core+own models, 05a Part B).
 *
 * `CrossTenantReadDelegate` is a *type-only* read restriction. A raw Prisma
 * delegate also carries `create`/`update`/`delete`/… — so without a runtime
 * facade an extension could call `(delegate as any).deleteMany({})`, an unscoped
 * cross-tenant write (job security review 2026-07-12, Finding 1). This module
 * builds a frozen, null-prototype facade exposing EXACTLY the five read methods
 * and nothing else; callers supply each method's implementation (a bound raw
 * method for jobs; a guard+audit-wrapped call for discover).
 */

import type { CrossTenantReadDelegate } from "@de-otio/trellis-extension-api";

/**
 * The five cross-tenant READ methods a delegate may expose. Anything else
 * (create/update/delete/…) must be unreachable at runtime.
 */
export const READ_DELEGATE_METHODS = [
  "findMany",
  "findFirst",
  "count",
  "aggregate",
  "groupBy",
] as const;

export type ReadDelegateMethod = (typeof READ_DELEGATE_METHODS)[number];

/**
 * Build a frozen, null-proto facade exposing exactly {@link READ_DELEGATE_METHODS}.
 * `resolve(method)` returns the implementation for each; a non-function result
 * (e.g. a missing method on a malformed delegate) throws, fail-closed.
 */
export function buildReadOnlyFacade(
  resolve: (method: ReadDelegateMethod) => unknown,
  label: string,
): CrossTenantReadDelegate {
  const facade: Record<string, unknown> = Object.create(null);
  for (const method of READ_DELEGATE_METHODS) {
    const fn = resolve(method);
    if (typeof fn !== "function") {
      throw new TypeError(`[${label}] read delegate is missing method: ${method}`);
    }
    facade[method] = fn;
  }
  return Object.freeze(facade) as unknown as CrossTenantReadDelegate;
}
