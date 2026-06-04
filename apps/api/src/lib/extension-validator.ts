/**
 * Extension Validator
 *
 * Validates extension registrations at startup:
 * - Extension IDs are valid format and not reserved
 * - No duplicate IDs
 * - Routes don't shadow core endpoints
 * - Warns about routes without auth middleware
 */

import type { TrellisExtension } from "@de-otio/trellis-extension-api";
import { getLogger, Logger } from "./logger.js";

const RESERVED_IDS = ["user", "admin", "system", "internal", ""];
const RESERVED_ROUTE_PREFIXES = [
  "/api/auth",
  "/api/admin",
  "/api/internal",
  "/.well-known",
];
const ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

const logger = getLogger();

export function validateExtensions(
  extensions: TrellisExtension[],
): void {
  const seen = new Set<string>();

  for (const ext of extensions) {
    // Validate ID format
    if (!ID_PATTERN.test(ext.id)) {
      throw new Error(
        `Extension ID "${ext.id}" must be lowercase alphanumeric, 2-32 chars`,
      );
    }
    if (RESERVED_IDS.includes(ext.id)) {
      throw new Error(`Extension ID "${ext.id}" is reserved`);
    }
    if (seen.has(ext.id)) {
      throw new Error(`Duplicate extension ID "${ext.id}"`);
    }
    seen.add(ext.id);

    // Validate routes don't shadow core endpoints
    for (const route of ext.routes) {
      const path =
        typeof route.path === "string"
          ? route.path
          : route.path instanceof RegExp
            ? route.path.source
            : String(route.path);
      for (const prefix of RESERVED_ROUTE_PREFIXES) {
        if (
          path.startsWith(prefix) ||
          path.startsWith(prefix.replace(/\//g, "\\/"))
        ) {
          throw new Error(
            `Extension "${ext.id}" route "${path}" conflicts with reserved prefix "${prefix}"`,
          );
        }
      }
    }

    // Warn about routes without auth middleware
    for (const route of ext.routes) {
      const hasAuth = route.middleware?.some(
        (m: any) =>
          m.name === "authMiddleware" || m.name === "csrfMiddleware",
      );
      if (!hasAuth) {
        logger.warn(
          `Extension "${ext.id}" route "${route.description ?? route.path}" has no auth middleware`,
        );
      }
    }
  }
}
