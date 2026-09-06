/**
 * Entity Profile Handlers
 *
 * Handlers for creating and retrieving entity profiles.
 * Replaces DogHandler for white-label support.
 *
 * Feature Flag: entity_profiles_enabled
 *
 * Why the feature flag exists:
 * - Part of white-label architecture preparation - allows per-tenant feature customization
 * - Enables gradual rollout of entity profiles feature
 * - Allows disabling the feature if issues are discovered
 * - Supports subscription-tier based feature access (future)
 * - Provides safety mechanism during development/testing phases
 */

import { DataRouter } from "./data-router.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";
import { detectRegion } from "./region-detection.js";
import { deriveUniqueHandle } from "./user/derive-handle.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { Session } from "./session-cookie.js";
import { SessionManager } from "./session-cookie.js";
import { Validator } from "./validation.js";

import { getExtension } from "../extensions.js";
import type { Env } from "../env.js";

/**
 * Precise-location keys stripped from an entity's metadata before it is served
 * to a NON-owner (anti-targeting; Milestone S). Coordinates are the sensitive
 * signal — a coarse place label / distanceBand is exposed elsewhere, but exact
 * lat/lng must never reach a stranger via the wholesale profile metadata.
 */
const PRECISE_LOCATION_KEYS = [
  "lat",
  "lng",
  "latitude",
  "longitude",
  "geo",
  "coordinates",
] as const;

/** Return a shallow copy of `metadata` with precise-location keys removed. */
function stripPreciseLocation(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...metadata };
  for (const key of PRECISE_LOCATION_KEYS) {
    delete copy[key];
  }
  return copy;
}

/**
 * Entity Handler class for managing entity profiles
 */
export class EntityHandler {
  private validator: Validator;
  private logger: Logger;

  constructor(env?: LoggerEnv) {
    this.validator = new Validator();
    this.logger = getLogger();
  }

  /**
   * Calculate and update life stage for an entity
   * This is a helper function that can be called when creating/updating entities
   * @param metadata - Entity metadata containing birthdate and breedSize
   * @param lifeStageManualOverride - Whether manual override is set
   * @param existingLifeStage - Existing life stage (if updating)
   * @returns Life stage taxon ID or null
   */
  private calculateEntityLifeStage(
    entityType: string,
    metadata: Record<string, any> | null | undefined,
    lifeStageManualOverride: boolean,
    existingLifeStage?: string | null,
  ): string | null {
    const ext = getExtension(entityType);
    if (!ext?.computeLifeStage) return null;
    return ext.computeLifeStage(metadata, lifeStageManualOverride, existingLifeStage ?? null);
  }

  /**
   * Create or update an entity profile
   */
  async createEntityProfile(
    request: Request,
    session: Session,
    env: Env,
  ): Promise<Response> {
    console.error("[ENTITY_HANDLER] createEntityProfile called", {
      userId: session.userId,
      email: session.email,
    });
    try {
      const body = await request.json();

      // Validate input
      const validation = this.validator.validateEntityProfile(body);
      if (!validation.valid) {
        return new Response(JSON.stringify({ error: validation.error }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const profileData = validation.data!;

      // Check if entity profiles feature is enabled
      const { FeatureToggleService } = await import("./feature-toggle-service.js");
      const { createPrisma } = await import("../db.js");
      const defaultDb = createPrisma(env);
      const toggleService = new FeatureToggleService(defaultDb);
      const entityProfilesEnabled = await toggleService.isEnabled(
        "entity_profiles_enabled",
      );

      if (!entityProfilesEnabled) {
        return new Response(
          JSON.stringify({
            error: "Entity profiles feature is currently disabled",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      // Check if public posting is enabled when privacy is set to "public"
      const privacy = profileData.metadata?.privacy;
      if (privacy === "public") {
        const publicPostingEnabled = await toggleService.isEnabled(
          "global_public_posting_enabled",
        );

        if (!publicPostingEnabled) {
          return new Response(
            JSON.stringify({
              error: "PUBLIC_POSTING_DISABLED",
              message:
                'Public privacy is currently disabled. Please use "followers" or "private" privacy.',
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }
      }

      // CRITICAL: Use user's dataRegion from session (not detected region)
      // This ensures entity is created in the same region as the user
      const finalRegion: string =
        session.dataRegion || env.DEFAULT_REGION || "EU";

      // Get region-specific database using DataRouter
      const db = DataRouter.getDatabaseForRegion(
        finalRegion,
        env,
        request,
        session.userId,
      );

      // Ensure user exists in database before creating entity
      // This prevents foreign key constraint violations if user was created in Supabase Auth
      // but not yet synced to the database
      console.error(
        "[ENTITY_HANDLER] Ensuring user exists before creating entity",
        {
          userId: session.userId,
          email: session.email,
          region: finalRegion,
        },
      );
      this.logger.error(
        "[ENTITY_HANDLER] Ensuring user exists before creating entity",
        {
          userId: session.userId,
          email: session.email,
          region: finalRegion,
        },
      );
      // Resolved from the user row the upsert below returns; feeds the
      // tenant resolution that scopes the entity (see the create call).
      let personalTenantId: string | null = null;
      try {
        console.error("[ENTITY_HANDLER] About to upsert user", {
          userId: session.userId,
          email: session.email,
          region: finalRegion,
        });
        const fallbackEmail =
          session.email || `user-${session.userId}@unknown.local`;
        // S-CP2: handle is non-null + unique — derive one for this fallback
        // provisioning path too (not just post-confirmation).
        const handle = await deriveUniqueHandle(
          db,
          fallbackEmail,
          session.userId,
        );
        const user = await (db.user.upsert({
          where: { id: session.userId },
          create: {
            id: session.userId,
            email: fallbackEmail,
            handle,
            role: session.role || "END_USER",
            region: finalRegion,
            dataRegion: finalRegion, // dataRegion must match region for compliance
          },
          update: {
            // Update email if it changed (e.g., user updated email in Supabase)
            ...(session.email ? { email: session.email } : {}),
            // Don't update region/dataRegion on existing users (preserve their region)
          },
        }) as unknown as Promise<{
          id: string;
          email: string;
          personalTenantId?: string | null;
        }>);
        // The upsert returns the whole row, so the personal tenant needed to
        // scope the entity below costs no extra query.
        personalTenantId = user.personalTenantId ?? null;
        console.error("[ENTITY_HANDLER] User ensured successfully", {
          userId: user.id,
          email: user.email,
        });
        this.logger.error("[ENTITY_HANDLER] User ensured successfully", {
          userId: user.id,
          email: user.email,
        });
      } catch (userError: any) {
        this.logger.error("Error ensuring user exists:", {
          error: userError,
          userId: session.userId,
          email: session.email,
          region: finalRegion,
          errorMessage: userError?.message,
          errorCode: userError?.code,
        });
        // If user creation fails, we can't create the entity
        return new Response(
          JSON.stringify({
            error: "Failed to verify user account. Please try again.",
          }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Note: Entity ID will be auto-generated by Prisma (cuid() default)

      // Prepare entity data
      // Note: id is auto-generated by Prisma (cuid() default)
      const entityType = profileData.entityType;
      if (!entityType) {
        return new Response(
          JSON.stringify({ error: "MISSING_ENTITY_TYPE", message: "entityType is required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const metadata = profileData.metadata || {};
      const metadataStr = JSON.stringify(metadata);
      if (metadataStr.length > 64_000) {
        return new Response(
          JSON.stringify({ error: "METADATA_TOO_LARGE", message: "Metadata exceeds 64KB limit" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const extension = getExtension(entityType);
      if (!extension) {
        return new Response(
          JSON.stringify({ error: "UNKNOWN_ENTITY_TYPE", message: `Unknown entityType: ${entityType}` }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Calculate life stage if metadata contains birthdate
      const calculatedLifeStage = this.calculateEntityLifeStage(
        entityType,
        profileData.metadata,
        (body as any).lifeStageManualOverride || false,
        (body as any).lifeStage,
      );

      const metadataValidation = extension.metadataSchema.safeParse(metadata);
      if (!metadataValidation.success) {
        return new Response(
          JSON.stringify({ error: "INVALID_METADATA", message: metadataValidation.error.issues.map((e: any) => e.message).join(", ") }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Multi-tenancy (v0.7): `Entity.tenantId` is a required relation and
      // ownership moved off the row into `EntityOwnership`. This handler was
      // not updated with the rest of the identity-federation migration, so it
      // wrote neither — it sent an `ownerId` scalar that no longer exists and
      // omitted the tenant, and every create 500'd on `Argument 'tenant' is
      // missing`. `entityData` is `any`, so the compiler never saw it.
      //
      // Tenant resolution follows the same rule as the media write path
      // (lib/media/tenant-resolution.ts): the ambient tenant from the auth
      // seam wins; with TENANT_SCOPE_MODE="off" (the default) fall back to the
      // creator's personal tenant. FAIL CLOSED — never guess a tenant.
      const { getCurrentTenantId } = await import(
        "@de-otio/saas-foundation/tenant"
      );
      const { resolveTenantScopeMode } = await import("./tenant-scope.js");
      const { resolveWriteTenantId } = await import(
        "./media/tenant-resolution.js"
      );
      const tenantResolution = resolveWriteTenantId(
        getCurrentTenantId(),
        personalTenantId,
        resolveTenantScopeMode(),
      );
      if (!tenantResolution.ok) {
        this.logger.warn(
          "[ENTITY_HANDLER] Refusing entity create — no tenant could be resolved",
          { userId: session.userId, region: finalRegion },
        );
        return new Response(
          JSON.stringify({
            error: "NO_ACTIVE_TENANT",
            message: "No active tenant for this account",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      const entityTenantId = tenantResolution.tenantId;

      const entityData: any = {
        name: profileData.name.trim(),
        entityType,
        tenantId: entityTenantId,
        metadata,
        // The creator's ownership row, written in the same statement so an
        // entity is never persisted without an owner. (The graph dual-write
        // below also upserts it, but only when an AMBIENT tenant is set —
        // which it is not in the default scope mode.)
        owners: {
          create: {
            tenantId: entityTenantId,
            userId: session.userId,
            role: "PRIMARY_OWNER",
            addedByUserId: session.userId,
          },
        },
      };

      // Set life stage if calculated
      if (calculatedLifeStage) {
        entityData.lifeStage = calculatedLifeStage;
        entityData.lifeStageCalculatedAt = new Date();
        entityData.lifeStageManualOverride =
          (body as any).lifeStageManualOverride || false;
      }

      // Create entity in database
      const entity = await (db.entity.create({
        data: entityData,
      }) as unknown as Promise<{
        id: string;
        tenantId: string;
        name: string;
        entityType: string | null;
        metadata: any;
        lifeStage: string | null;
        createdAt: Date;
        updatedAt: Date;
      }>);

      // Dual-write: sync entity and ownership to graph database
      try {
        const { createGraphServiceFromEnv } = await import("./graph/index.js");
        const graphService = await createGraphServiceFromEnv(env);

        const syncInput: { id: string; entityType: string; name: string; tenantId?: string; breed?: string; lifeStage?: string; lat?: number; lng?: number } = {
          id: entity.id,
          entityType: entity.entityType || "",
          name: entity.name,
          tenantId: entity.tenantId,
        };
        const md = (entity.metadata || {}) as Record<string, any>;
        if (md.breed) syncInput.breed = md.breed;
        if (entity.lifeStage) syncInput.lifeStage = entity.lifeStage;
        // Full precision — geo is stored in Postgres/PostGIS now (C7); exposure
        // coarsening is a read-time policy, not a write-time mutilation.
        if (typeof md.lat === "number") syncInput.lat = md.lat;
        if (typeof md.lng === "number") syncInput.lng = md.lng;

        await graphService.syncEntity(syncInput);
        await graphService.syncOwnership({
          entityId: entity.id,
          userId: session.userId,
          role: "PRIMARY_OWNER",
        });
      } catch (graphError: any) {
        this.logger.error("[ENTITY_HANDLER] Graph sync failed after entity create (non-fatal)", {
          entityId: entity.id,
          userId: session.userId,
          error: graphError.message,
        });
      }

      // Format response for frontend (matching EntityProfileModel structure)
      // The frontend expects: id, name, entityType, metadata, createdAt, updatedAt
      const responseData = {
        id: entity.id,
        name: entity.name,
        entityType: entity.entityType,
        metadata: entity.metadata || {},
        createdAt: entity.createdAt.toISOString(),
        updatedAt: entity.updatedAt.toISOString(),
      };

      return new Response(JSON.stringify(responseData), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      this.logger.error("Error creating entity profile:", error);

      return new Response(
        JSON.stringify({ error: this.validator.sanitizeError(error) }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  /**
   * Get an entity profile by ID
   */
  async getEntityProfile(
    entityId: string,
    session: Session,
    env: Env,
    request?: Request,
  ): Promise<Response> {
    // Check if entity profiles feature is enabled
    const { FeatureToggleService } = await import("./feature-toggle-service.js");
    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);
    const toggleService = new FeatureToggleService(db);
    const entityProfilesEnabled = await toggleService.isEnabled(
      "entity_profiles_enabled",
    );

    if (!entityProfilesEnabled) {
      return new Response(
        JSON.stringify({
          error: "Entity profiles feature is currently disabled",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }

    try {
      // CRITICAL FIX: Search all regions for entity, starting with user's dataRegion
      // This ensures we find entities even if session.dataRegion doesn't match where entity was created
      const { DataRouter } = await import("./data-router.js");
      const userDataRegion: string =
        session.dataRegion || env.DEFAULT_REGION || "EU";

      // Search for entity, starting with user's dataRegion
      let entity: {
        id: string;
        name: string;
        entityType: string | null;
        metadata: any;
        createdAt: Date;
        updatedAt: Date;
        owners: { userId: string; role: string }[];
      } | null = null;
      let hadDbError = false;

      const regionsToSearch = [
        userDataRegion,
        ...(["EU", "US", "CN"] as const).filter((r) => r !== userDataRegion),
      ];

      for (const region of regionsToSearch) {
        try {
          const regionDb = DataRouter.getDatabaseForRegion(
            region,
            env,
            request,
            session.userId,
          );

          entity = await (regionDb.entity.findUnique({
            where: { id: entityId },
            select: {
              id: true,
              name: true,
              entityType: true,
              metadata: true,
              createdAt: true,
              updatedAt: true,
              owners: { select: { userId: true, role: true }, where: { status: 'ACTIVE' } },
            },
          }) as unknown as Promise<{
            id: string;
            name: string;
            entityType: string | null;
            metadata: any;
            createdAt: Date;
            updatedAt: Date;
            owners: { userId: string; role: string }[];
          } | null>);

          if (entity) {
            if (region !== userDataRegion) {
              this.logger.info(
                "[ENTITY_HANDLER] getEntityProfile: Entity found in different region than user dataRegion",
                {
                  entityId,
                  userId: session.userId,
                  foundRegion: region,
                  userDataRegion,
                },
              );
            } else {
              this.logger.info(
                "[ENTITY_HANDLER] getEntityProfile: Entity found in user dataRegion",
                {
                  entityId,
                  userId: session.userId,
                  foundRegion: region,
                  entityName: entity.name,
                  entityUpdatedAt: entity.updatedAt,
                },
              );
            }
            break;
          }
        } catch (error: any) {
          hadDbError = true;
          // Continue searching other regions
          this.logger.debug(
            "[ENTITY_HANDLER] Error searching region for entity",
            {
              region,
              error: error.message,
            },
          );
        }
      }

      if (!entity) {
        if (hadDbError) {
          return new Response(
            JSON.stringify({ error: "Database error retrieving entity" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "Entity not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // Check if user owns the entity (for private profiles)
      // Public profiles can be viewed by anyone, but we still check ownership for private ones
      const metadata = entity.metadata || {};
      const privacy = metadata.privacy || "public";
      const isOwner = entity.owners?.[0]?.userId === session.userId;
      if (privacy === "private" && !isOwner) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }

      // Anti-targeting (Milestone S / plan 011 WS-B): NEVER expose an entity's
      // precise coordinates to a non-owner. A stalker/thief locating the dog is
      // the core threat this platform guards against; discovery already returns
      // only a coarse distanceBand (Finding 15), so the wholesale profile
      // metadata must not become a precise-location side channel. Owners see
      // their own full metadata; everyone else gets it with precise-location
      // keys stripped.
      const responseData = {
        id: entity.id,
        name: entity.name,
        entityType: entity.entityType,
        metadata: isOwner
          ? entity.metadata || {}
          : stripPreciseLocation(entity.metadata || {}),
        createdAt: entity.createdAt.toISOString(),
        updatedAt: entity.updatedAt.toISOString(),
      };

      return new Response(JSON.stringify(responseData), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      this.logger.error("Error getting entity profile:", error);
      return new Response(
        JSON.stringify({ error: this.validator.sanitizeError(error) }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Update an entity profile
   */
  async updateEntityProfile(
    entityId: string,
    request: Request,
    session: Session,
    env: Env,
  ): Promise<Response> {
    try {
      const body = await request.json();

      // Validate input
      const validation = this.validator.validateEntityProfile(body);
      if (!validation.valid) {
        return new Response(JSON.stringify({ error: validation.error }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const profileData = validation.data!;

      // Check if entity profiles feature is enabled
      const { FeatureToggleService } = await import("./feature-toggle-service.js");
      const { createPrisma } = await import("../db.js");
      const defaultDb = createPrisma(env);
      const toggleService = new FeatureToggleService(defaultDb);
      const entityProfilesEnabled = await toggleService.isEnabled(
        "entity_profiles_enabled",
      );

      if (!entityProfilesEnabled) {
        this.logger.error(
          "[ENTITY_HANDLER] updateEntityProfile: entity_profiles_enabled is false",
          {
            entityId,
            userId: session.userId,
          },
        );
        return new Response(
          JSON.stringify({
            error: "ENTITY_PROFILES_DISABLED",
            message: "Entity profiles feature is currently disabled",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      // CRITICAL FIX: Use user's dataRegion to find entity, not detected region
      // Entities are stored in the same region as the user's dataRegion (where they were created)
      // Region detection can vary (IP geolocation, user preference changes), causing entity lookup failures
      const { DataRouter } = await import("./data-router.js");

      // First, get user's dataRegion (where their entities are stored)
      let entityRegion: string = env.DEFAULT_REGION || "EU";
      try {
        // Try to get user's dataRegion from their user record
        // Try EU first (most common), then US, then CN
        for (const region of ["EU", "US", "CN"] as const) {
          const user = await DataRouter.getUser(
            session.userId,
            region,
            env,
            request,
          );
          if (user?.dataRegion) {
            entityRegion = user.dataRegion;
            break;
          }
        }
      } catch (error: any) {
        this.logger.warn(
          "[ENTITY_HANDLER] Could not get user dataRegion, using detected region",
          {
            userId: session.userId,
            error: error.message,
          },
        );
        // Fallback to detected region if user lookup fails
        const sessionManager = new SessionManager();
        const sessionSecret = env.SESSION_SECRET;
        const sessionForRegion = await sessionManager.getSession(
          request,
          sessionSecret,
          env,
        );
        const { detectRegion } = await import("./region-detection.js");
        const detectedRegion = await detectRegion(
          request,
          env,
          sessionManager,
          sessionForRegion,
        );
        entityRegion = detectedRegion || env.DEFAULT_REGION || "EU";
      }

      // Search for entity, starting with user's dataRegion
      let existingEntity: {
        id: string;
        entityType: string | null;
        metadata: any;
        lifeStage: string | null;
        lifeStageManualOverride: boolean;
        owners: { userId: string; role: string }[];
      } | null = null;
      let foundRegion = entityRegion;
      const regionsToSearch = [
        entityRegion,
        ...(["EU", "US", "CN"] as const).filter((r) => r !== entityRegion),
      ];

      for (const region of regionsToSearch) {
        try {
          const regionDb = DataRouter.getDatabaseForRegion(
            region,
            env,
            request,
            session.userId,
          );
          existingEntity = await (regionDb.entity.findUnique({
            where: { id: entityId },
            select: {
              id: true,
              entityType: true,
              metadata: true,
              lifeStage: true,
              lifeStageManualOverride: true,
              owners: { select: { userId: true, role: true }, where: { status: 'ACTIVE' } },
            },
          }) as unknown as Promise<{
            id: string;
            entityType: string | null;
            metadata: any;
            lifeStage: string | null;
            lifeStageManualOverride: boolean;
            owners: { userId: string; role: string }[];
          } | null>);

          if (existingEntity) {
            foundRegion = region;
            if (region !== entityRegion) {
              this.logger.info(
                "[ENTITY_HANDLER] Entity found in different region than user dataRegion",
                {
                  entityId,
                  userId: session.userId,
                  foundRegion: region,
                  userDataRegion: entityRegion,
                },
              );
            }
            break;
          }
        } catch (error: any) {
          // Continue searching other regions
          this.logger.debug(
            "[ENTITY_HANDLER] Error searching region for entity",
            {
              region,
              error: error.message,
            },
          );
        }
      }

      if (!existingEntity) {
        this.logger.error(
          "[ENTITY_HANDLER] updateEntityProfile: Entity not found in any region",
          {
            entityId,
            userId: session.userId,
            searchedRegions: regionsToSearch,
          },
        );
        return new Response(JSON.stringify({ error: "Entity not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // Log which region the entity was found in
      this.logger.info("[ENTITY_HANDLER] updateEntityProfile: Entity found", {
        entityId,
        userId: session.userId,
        foundRegion,
        entityRegion,
        searchedRegions: regionsToSearch,
      });

      // Use the region where the entity was found for the update operation
      const db = DataRouter.getDatabaseForRegion(
        foundRegion,
        env,
        request,
        session.userId,
      );

      if (!existingEntity.owners?.some((o: any) => o.userId === session.userId)) {
        this.logger.error(
          "[ENTITY_HANDLER] updateEntityProfile: Ownership mismatch",
          {
            entityId,
            entityOwnerIds: existingEntity.owners?.map((o: any) => o.userId),
            sessionUserId: session.userId,
            region: foundRegion,
          },
        );
        return new Response(
          JSON.stringify({
            error: "OWNERSHIP_MISMATCH",
            message: "You do not have permission to update this entity",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      // Check if public posting is enabled when privacy is set to "public"
      const privacy = profileData.metadata?.privacy;
      if (privacy === "public") {
        const publicPostingEnabled = await toggleService.isEnabled(
          "global_public_posting_enabled",
        );

        if (!publicPostingEnabled) {
          return new Response(
            JSON.stringify({
              error: "PUBLIC_POSTING_DISABLED",
              message:
                'Public privacy is currently disabled. Please use "followers" or "private" privacy.',
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }
      }

      // Calculate life stage if metadata contains birthdate
      const calculatedLifeStage = this.calculateEntityLifeStage(
        existingEntity.entityType || profileData.entityType || "",
        profileData.metadata,
        (body as any).lifeStageManualOverride ||
          existingEntity.lifeStageManualOverride,
        existingEntity.lifeStage,
      );

      // Merge metadata (preserve existing fields that aren't being updated)
      const existingMetadata = existingEntity.metadata || {};
      const incomingMetadata = profileData.metadata || {};

      // Merge metadata, preserving existing fields that aren't explicitly updated
      // Only update fields that are present in incomingMetadata
      // This ensures avatar and other fields are preserved if not included in the update
      const updatedMetadata = {
        ...existingMetadata,
      };

      // Only update fields that are explicitly provided in the update
      for (const [key, value] of Object.entries(incomingMetadata)) {
        // If value is explicitly null, allow it to clear the field
        // If value is undefined, skip it (preserve existing)
        if (value !== undefined) {
          updatedMetadata[key] = value;
        }
      }

      // Prepare update data
      const updateData: any = {
        updatedAt: new Date(),
      };

      if (profileData.name) {
        updateData.name = profileData.name.trim();
      }

      if (profileData.metadata) {
        updateData.metadata = updatedMetadata;
      }

      // Set life stage if calculated
      if (calculatedLifeStage) {
        updateData.lifeStage = calculatedLifeStage;
        updateData.lifeStageCalculatedAt = new Date();
        updateData.lifeStageManualOverride =
          (body as any).lifeStageManualOverride ||
          existingEntity.lifeStageManualOverride;
      }

      // Update entity in database
      const entity = await (db.entity.update({
        where: { id: entityId },
        data: updateData,
      }) as unknown as Promise<{
        id: string;
        tenantId: string;
        name: string;
        entityType: string | null;
        metadata: any;
        lifeStage: string | null;
        createdAt: Date;
        updatedAt: Date;
      }>);

      // Dual-write: sync updated entity to graph database
      try {
        const { createGraphServiceFromEnv } = await import("./graph/index.js");
        const graphService = await createGraphServiceFromEnv(env);

        const syncInput: { id: string; entityType: string; name: string; tenantId?: string; breed?: string; lifeStage?: string; lat?: number; lng?: number } = {
          id: entity.id,
          entityType: entity.entityType || "",
          name: entity.name,
          tenantId: entity.tenantId,
        };
        const md = (entity.metadata || {}) as Record<string, any>;
        if (md.breed) syncInput.breed = md.breed;
        if (entity.lifeStage) syncInput.lifeStage = entity.lifeStage;
        // Full precision — geo is stored in Postgres/PostGIS now (C7); exposure
        // coarsening is a read-time policy, not a write-time mutilation.
        if (typeof md.lat === "number") syncInput.lat = md.lat;
        if (typeof md.lng === "number") syncInput.lng = md.lng;

        await graphService.syncEntity(syncInput);
      } catch (graphError: any) {
        this.logger.error("[ENTITY_HANDLER] Graph sync failed after entity update (non-fatal)", {
          entityId: entity.id,
          userId: session.userId,
          error: graphError.message,
        });
      }

      // Format response for frontend
      const responseData = {
        id: entity.id,
        name: entity.name,
        entityType: entity.entityType,
        metadata: entity.metadata || {},
        createdAt: entity.createdAt.toISOString(),
        updatedAt: entity.updatedAt.toISOString(),
      };

      return new Response(JSON.stringify(responseData), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      this.logger.error("Error updating entity profile:", error);

      return new Response(
        JSON.stringify({ error: this.validator.sanitizeError(error) }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  /**
   * List user's entity profiles
   * Returns entities owned by the user for tagging in posts
   */
  async listEntityProfiles(
    session: Session,
    env: Env,
    request?: Request,
    requestContext?: TrellisRequestContext,
  ): Promise<Response> {
    // Check if entity profiles feature is enabled
    const { FeatureToggleService } = await import("./feature-toggle-service.js");
    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);
    const toggleService = new FeatureToggleService(db);
    const entityProfilesEnabled = await toggleService.isEnabled(
      "entity_profiles_enabled",
    );

    if (!entityProfilesEnabled) {
      return new Response(
        JSON.stringify({
          error: "Entity profiles feature is currently disabled",
          profiles: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    try {
      // CRITICAL: Use user's dataRegion from session (not detected region)
      // This ensures we always query the correct database where user's data is stored
      const userDataRegion: string =
        session.dataRegion || env.DEFAULT_REGION || "EU";

      // Get region-specific database with timeout/retry logic
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );

      // Fetch entities owned by the user from their dataRegion
      let entities: any[] = [];
      try {
        entities = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          userDataRegion,
          env as any,
          async (db) => {
            return await db.entity.findMany({
              where: {
                owners: { some: { userId: session.userId, status: 'ACTIVE' } },
              },
              select: {
                id: true,
                name: true,
                entityType: true,
                metadata: true,
                createdAt: true,
              },
              orderBy: {
                name: "asc",
              },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING,
            maxRetries: 3,
            baseDelayMs: 100,
            context: {
              operation: "listEntityProfiles",
              userId: session.userId,
              region: userDataRegion,
            },
          },
        );

        this.logger.debug(
          "[ENTITY_HANDLER] Listed entities from user dataRegion",
          {
            userId: session.userId,
            userDataRegion,
            entityCount: entities.length,
          },
        );
      } catch (error: any) {
        this.logger.error(
          "[ENTITY_HANDLER] Error listing entities from user dataRegion",
          {
            region: userDataRegion,
            userId: session.userId,
            error: error.message,
          },
        );
        throw error;
      }

      // Format response for frontend
      const profiles = entities.map((entity: any) => ({
        id: entity.id,
        name: entity.name,
        entityType: entity.entityType,
        metadata: entity.metadata || {},
        createdAt: entity.createdAt.toISOString(),
      }));

      return new Response(JSON.stringify({ profiles }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      this.logger.error("Error listing entity profiles:", error);
      return new Response(
        JSON.stringify({ error: this.validator.sanitizeError(error) }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Delete an entity profile
   */
  async deleteEntityProfile(
    entityId: string,
    session: Session,
    env: Env,
  ): Promise<Response> {
    try {
      // Check if entity profiles feature is enabled
      const { FeatureToggleService } = await import("./feature-toggle-service.js");
      const { createPrisma } = await import("../db.js");
      const defaultDb = createPrisma(env);
      const toggleService = new FeatureToggleService(defaultDb);
      const entityProfilesEnabled = await toggleService.isEnabled(
        "entity_profiles_enabled",
      );

      if (!entityProfilesEnabled) {
        return new Response(
          JSON.stringify({
            error: "Entity profiles feature is currently disabled",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      // Search for entity across all regions (similar to updateEntityProfile)
      // Start with user's dataRegion, then try other regions
      let entityRegion: string = env.DEFAULT_REGION || "EU";

      // Try to get user's dataRegion
      try {
        for (const region of ["EU", "US", "CN"] as const) {
          const user = await DataRouter.getUser(
            session.userId,
            region,
            env,
            null as any,
          );
          if (user?.dataRegion) {
            entityRegion = user.dataRegion;
            break;
          } else if (user?.region) {
            entityRegion = user.region;
            break;
          }
        }
      } catch (error: any) {
        this.logger.warn(
          "[ENTITY_HANDLER] Could not get user dataRegion for deletion",
          {
            userId: session.userId,
            error: error.message,
          },
        );
      }

      // Search for entity, starting with user's dataRegion
      let entity: {
        id: string;
        name: string;
        owners: { userId: string; role: string }[];
      } | null = null;
      let foundRegion = entityRegion;
      const regionsToSearch = [
        entityRegion,
        ...(["EU", "US", "CN"] as const).filter((r) => r !== entityRegion),
      ];

      for (const region of regionsToSearch) {
        try {
          const regionDb = DataRouter.getDatabaseForRegion(
            region,
            env,
            null as any,
            session.userId,
          );
          entity = await (regionDb.entity.findUnique({
            where: { id: entityId },
            select: { id: true, name: true, owners: { select: { userId: true, role: true }, where: { status: 'ACTIVE' } } },
          }) as unknown as Promise<{
            id: string;
            name: string;
            owners: { userId: string; role: string }[];
          } | null>);

          if (entity) {
            foundRegion = region;
            if (region !== entityRegion) {
              this.logger.info(
                "[ENTITY_HANDLER] Entity found in different region for deletion",
                {
                  entityId,
                  userId: session.userId,
                  foundRegion: region,
                  userDataRegion: entityRegion,
                },
              );
            }
            break;
          }
        } catch (error: any) {
          this.logger.debug(
            "[ENTITY_HANDLER] Error searching region for entity deletion",
            {
              region,
              error: error.message,
            },
          );
        }
      }

      if (!entity) {
        return new Response(JSON.stringify({ error: "Entity not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // Verify ownership
      if (!entity.owners?.some((o: any) => o.userId === session.userId)) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }

      // Delete the entity using the region where it was found
      const db = DataRouter.getDatabaseForRegion(
        foundRegion,
        env,
        null as any,
        session.userId,
      );

      console.error("[ENTITY_HANDLER] About to delete entity", {
        entityId,
        entityName: entity.name,
        userId: session.userId,
        region: foundRegion,
      });
      this.logger.error("[ENTITY_HANDLER] About to delete entity", {
        entityId,
        entityName: entity.name,
        userId: session.userId,
        region: foundRegion,
      });

      const deleteResult = await db.entity.delete({
        where: { id: entityId },
      });

      console.error("[ENTITY_HANDLER] Entity deleted successfully", {
        entityId,
        entityName: entity.name,
        userId: session.userId,
        region: foundRegion,
        deleteResult: JSON.stringify(deleteResult),
      });
      this.logger.error("[ENTITY_HANDLER] Entity deleted successfully", {
        entityId,
        entityName: entity.name,
        userId: session.userId,
        region: foundRegion,
        deleteResult: JSON.stringify(deleteResult),
      });

      // Dual-write: remove entity from graph database
      try {
        const { createGraphServiceFromEnv } = await import("./graph/index.js");
        const graphService = await createGraphServiceFromEnv(env);
        await graphService.removeEntity(entityId);
      } catch (graphError: any) {
        this.logger.error("[ENTITY_HANDLER] Graph sync failed after entity delete (non-fatal)", {
          entityId,
          userId: session.userId,
          error: graphError.message,
        });
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: "Entity deleted successfully",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      this.logger.error("Error deleting entity profile:", error);
      return new Response(
        JSON.stringify({ error: this.validator.sanitizeError(error) }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }
}
