/**
 * Directory Profile Handler
 *
 * Handles create/update/get of a tenant's public `TenantDirectoryProfile`.
 *
 * Routes:
 *   POST  /api/tenants/:id/directory-profile  — create profile (ADMIN+)
 *   PATCH /api/tenants/:id/directory-profile  — update profile (ADMIN+)
 *   GET   /api/tenants/:id/directory-profile  — read profile (own-tenant member)
 *
 * Authorization:
 *   - Mutations: `requireActiveTenant` (cross-tenant isolation) then
 *     `requireCapability(DirectoryEdit)` (ADMIN+ within tenant). The
 *     cross-tenant guard must come FIRST — a capability check alone only
 *     verifies the caller's role within their own active tenant, not that the
 *     path-parameter :id matches it.
 *   - GET: `requireOwnTenant` (returns 404, avoids existence-leak for cross-
 *     tenant callers).
 *
 * Location precision logic:
 *   - Default at creation: EXACT for ORGANIZATION tenants, CITY for PERSONAL.
 *   - NEIGHBORHOOD: true lat/lng are stored (needed for geo search); additionally
 *     `displayLat`/`displayLng` are computed at write time via a random offset
 *     bounded by the configured fuzz radius. Coarsening is stored, not computed
 *     at read time — departure from entity-geo-repository's read-time approach,
 *     deliberate per 05-schema-changes.md.
 *   - EXACT, CITY, HIDDEN: `displayLat`/`displayLng` are not stored (null).
 */

import type { LocationPrecision, TenantType } from "@prisma/client";
import type { Env } from "../../env.js";
import type { AuthContext } from "../auth/auth-context.js";
import { requireActiveTenant, requireOwnTenant } from "../auth/auth-middleware.js";
import { requireCapability, Capability } from "../auth/require.js";
import { emitDirectoryProfileAudit } from "./directory-profile-audit-emit.js";
import type { DirectoryProfileConfig } from "../org-category/directory-profile-config.js";
import { resolveDirectoryProfileConfig } from "../org-category/directory-profile-config.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Compute a fuzzed display coordinate for NEIGHBORHOOD-precision profiles.
 *
 * Applies a random displacement within a circle of `fuzzMeters` radius around
 * the true position. The offset is generated fresh at each write, so a repeat
 * update regenerates it (making back-calculation by comparing successive
 * updates harder).
 *
 * Returns `{ displayLat, displayLng }` — safe to store and return to any
 * authenticated API consumer.
 */
function computeNeighborhoodDisplay(
  lat: number,
  lng: number,
  fuzzMeters: number,
): { displayLat: number; displayLng: number } {
  const angle = Math.random() * 2 * Math.PI;
  // Uniform random distance within the circle (square-root for uniform area distribution)
  const distance = Math.sqrt(Math.random()) * fuzzMeters;

  // Convert metres to degrees (approximation valid for the low latitudes typical
  // of inhabited areas; accurate enough for neighbourhood-level display).
  const latDegPerMeter = 1 / 111_000;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Guard against cos ≈ 0 near poles (practically impossible for a social-network
  // tenant profile, but avoids division-by-zero producing Infinity).
  const lngDegPerMeter = cosLat > 1e-6 ? 1 / (111_000 * cosLat) : latDegPerMeter;

  return {
    displayLat: lat + Math.sin(angle) * distance * latDegPerMeter,
    displayLng: lng + Math.cos(angle) * distance * lngDegPerMeter,
  };
}

/**
 * Default `locationPrecision` at profile-creation time, derived from the
 * owning tenant's `type` per 05-schema-changes.md: ORGANIZATION tenants
 * typically want to be locatable (EXACT default), PERSONAL tenants default
 * to coarser (CITY) to reduce unintended location exposure.
 */
function defaultPrecisionForTenantType(tenantType: TenantType): LocationPrecision {
  return tenantType === "ORGANIZATION" ? "EXACT" : "CITY";
}

// ─── Zod schemas (lazily imported) ───────────────────────────────────────────

async function buildCreateSchema() {
  const { z } = await import("zod");
  return z.object({
    isDiscoverable: z.boolean().optional().default(false),
    shortDescription: z.string().max(500).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    locationLabel: z.string().max(200).optional(),
    locationPrecision: z
      .enum(["EXACT", "NEIGHBORHOOD", "CITY", "HIDDEN"])
      .optional(),
  });
}

async function buildUpdateSchema() {
  const { z } = await import("zod");
  return z.object({
    isDiscoverable: z.boolean().optional(),
    shortDescription: z.string().max(500).nullable().optional(),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    locationLabel: z.string().max(200).nullable().optional(),
    locationPrecision: z
      .enum(["EXACT", "NEIGHBORHOOD", "CITY", "HIDDEN"])
      .optional(),
  });
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export class DirectoryProfileHandler {
  private readonly config: DirectoryProfileConfig;

  /**
   * @param config - optional override for tests; production callers omit this
   *   and the handler resolves config from the process environment.
   */
  constructor(config?: DirectoryProfileConfig) {
    this.config = config ?? resolveDirectoryProfileConfig();
  }

  /**
   * POST /api/tenants/:id/directory-profile
   *
   * Creates the tenant's directory profile. Fails with 409 if a profile
   * already exists (use PATCH to update). ADMIN+ only. Cross-tenant isolation
   * guard runs before capability check.
   */
  async handleCreate(
    tenantId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    // Cross-tenant isolation guard MUST come before capability check.
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireCapability(auth, Capability.DirectoryEdit);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "INVALID_JSON", message: "Request body must be valid JSON" }, 400);
    }

    const schema = await buildCreateSchema();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return json(
        { error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid input" },
        400,
      );
    }

    const { isDiscoverable, shortDescription, lat, lng, locationLabel, locationPrecision } =
      parsed.data;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    // Load the tenant to determine the default precision.
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, type: true },
    });
    if (!tenant) {
      return json({ error: "NOT_FOUND", message: "Tenant not found" }, 404);
    }

    // Existing profile? Return 409.
    const existing = await db.tenantDirectoryProfile.findUnique({
      where: { tenantId },
    });
    if (existing) {
      return json(
        {
          error: "CONFLICT",
          message: "A directory profile already exists. Use PATCH to update it.",
        },
        409,
      );
    }

    const resolvedPrecision: LocationPrecision =
      locationPrecision ?? defaultPrecisionForTenantType(tenant.type);

    // Compute display coordinates for NEIGHBORHOOD precision.
    let displayLat: number | null = null;
    let displayLng: number | null = null;
    if (resolvedPrecision === "NEIGHBORHOOD" && lat != null && lng != null) {
      const fuzzed = computeNeighborhoodDisplay(lat, lng, this.config.neighborhoodFuzzMeters);
      displayLat = fuzzed.displayLat;
      displayLng = fuzzed.displayLng;
    }

    const profile = await db.tenantDirectoryProfile.create({
      data: {
        tenantId,
        isDiscoverable,
        shortDescription: shortDescription ?? null,
        lat: lat ?? null,
        lng: lng ?? null,
        displayLat,
        displayLng,
        locationLabel: locationLabel ?? null,
        locationPrecision: resolvedPrecision,
      },
    });

    emitDirectoryProfileAudit(
      {
        tenantId,
        actorUserId: auth.userId,
        action: "directory_profile.created",
        targetId: profile.id,
        metadata: { isDiscoverable, locationPrecision: resolvedPrecision },
      },
      db,
    );

    return json(profile, 201);
  }

  /**
   * PATCH /api/tenants/:id/directory-profile
   *
   * Updates the tenant's existing directory profile. Returns 404 if the
   * profile has not been created yet. ADMIN+ only. Cross-tenant isolation
   * guard runs before capability check.
   */
  async handleUpdate(
    tenantId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireCapability(auth, Capability.DirectoryEdit);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "INVALID_JSON", message: "Request body must be valid JSON" }, 400);
    }

    const schema = await buildUpdateSchema();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return json(
        { error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid input" },
        400,
      );
    }

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const existing = await db.tenantDirectoryProfile.findUnique({
      where: { tenantId },
    });
    if (!existing) {
      return json(
        { error: "NOT_FOUND", message: "Directory profile not found. Use POST to create it." },
        404,
      );
    }

    const patch = parsed.data;

    // Determine the new precision (patch may change it; fall back to current).
    const newPrecision: LocationPrecision =
      patch.locationPrecision ?? existing.locationPrecision;

    // Resolve the authoritative lat/lng (patch may clear them with null).
    const newLat = "lat" in patch ? (patch.lat ?? null) : existing.lat;
    const newLng = "lng" in patch ? (patch.lng ?? null) : existing.lng;

    // Recompute display coordinates whenever NEIGHBORHOOD is the final
    // precision AND coordinates are present. This regenerates the fuzz
    // on each update, which is intentional (replay-attack mitigation).
    let newDisplayLat: number | null = null;
    let newDisplayLng: number | null = null;
    if (newPrecision === "NEIGHBORHOOD" && newLat != null && newLng != null) {
      const fuzzed = computeNeighborhoodDisplay(newLat, newLng, this.config.neighborhoodFuzzMeters);
      newDisplayLat = fuzzed.displayLat;
      newDisplayLng = fuzzed.displayLng;
    }

    // Build the update payload — only fields explicitly provided in the patch.
    const updateData: Record<string, unknown> = {
      locationPrecision: newPrecision,
      displayLat: newDisplayLat,
      displayLng: newDisplayLng,
    };
    if ("isDiscoverable" in patch && patch.isDiscoverable !== undefined) {
      updateData.isDiscoverable = patch.isDiscoverable;
    }
    if ("shortDescription" in patch) {
      updateData.shortDescription = patch.shortDescription;
    }
    if ("lat" in patch) {
      updateData.lat = patch.lat;
    }
    if ("lng" in patch) {
      updateData.lng = patch.lng;
    }
    if ("locationLabel" in patch) {
      updateData.locationLabel = patch.locationLabel;
    }

    const updated = await db.tenantDirectoryProfile.update({
      where: { tenantId },
      data: updateData,
    });

    // Emit targeted audit events for the two security-sensitive transitions.
    const discoverableChanged =
      "isDiscoverable" in patch &&
      patch.isDiscoverable !== undefined &&
      patch.isDiscoverable !== existing.isDiscoverable;

    const precisionChanged = newPrecision !== existing.locationPrecision;

    if (discoverableChanged) {
      emitDirectoryProfileAudit(
        {
          tenantId,
          actorUserId: auth.userId,
          action: "directory_profile.discoverable_changed",
          targetId: existing.id,
          metadata: {
            previousValue: existing.isDiscoverable,
            newValue: patch.isDiscoverable as boolean,
          },
        },
        db,
      );
    }

    if (precisionChanged) {
      emitDirectoryProfileAudit(
        {
          tenantId,
          actorUserId: auth.userId,
          action: "directory_profile.precision_changed",
          targetId: existing.id,
          metadata: {
            previousValue: existing.locationPrecision,
            newValue: newPrecision,
          },
        },
        db,
      );
    }

    return json(updated, 200);
  }

  /**
   * GET /api/tenants/:id/directory-profile
   *
   * Returns the tenant's directory profile. Open to any member of the
   * requesting tenant (caller must belong to the same tenant). Uses
   * `requireOwnTenant` (returns 404 for cross-tenant callers to avoid
   * existence-leak — a 403 would confirm the profile exists for this tenant).
   */
  async handleGet(
    tenantId: string,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied = requireOwnTenant(auth, tenantId);
    if (denied) return denied;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const profile = await db.tenantDirectoryProfile.findUnique({
      where: { tenantId },
    });

    if (!profile) {
      return json({ error: "NOT_FOUND", message: "Directory profile not found" }, 404);
    }

    return json(profile, 200);
  }
}
