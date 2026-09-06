/**
 * The `ReportCategory.routingClass` values (mirrors the Prisma `RoutingClass`
 * enum in `prisma/schema.prisma`). Shared here so the admin handlers that
 * validate against it — `content-report-admin-handler.ts`,
 * `report-category-admin-handler.ts` — and the seed script import one
 * definition instead of retyping the same four-value array (quality sweep
 * 2026-09-05, D1).
 *
 * Deliberately its own module, NOT part of `report-templates.ts`: that file
 * is re-exported from the package's public `index.ts`, and the public-API
 * snapshot captures a reachable declaration file's whole content — so an
 * export added there ships as part of the published `@de-otio/trellis`
 * contract even if `index.ts` never names it. None of this module's
 * importers are reachable from the public entry, so it stays internal.
 */

export const ROUTING_CLASSES = [
  "ILLEGAL_PRIORITY",
  "ILLEGAL",
  "POLICY_VIOLATION",
  "FEEDBACK",
] as const;

export type RoutingClass = (typeof ROUTING_CLASSES)[number];
