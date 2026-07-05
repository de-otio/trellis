/**
 * Route Registry
 *
 * Centralized route registry for the API.
 * This provides a cleaner way to organize routes and enables features like:
 * - Route versioning
 * - Middleware composition
 * - Route documentation
 * - Route testing
 *
 * Routes are organized by domain/feature in separate files and combined here.
 */

import { corsMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { actorRoutes } from "./activitypub/actor.js";
import { audienceRoutes } from "./activitypub/audiences.js";
import { collectionRoutes } from "./activitypub/collections.js";
import { friendsRoutes } from "./activitypub/friends.js";
import { groupRoutes } from "./activitypub/group.js";
import { inboxRoutes } from "./activitypub/inbox.js";
import { messageRoutes } from "./activitypub/messages.js";
import { outboxRoutes } from "./activitypub/outbox.js";
import { postRoutes as activitypubPostRoutes } from "./activitypub/post.js";
import { entityProfileRoutes } from "./activitypub/entity-profile.js";
import { webfingerRoutes } from "./activitypub/webfinger.js";
import { adminRoutes } from "./admin.js";
import { adminCostRoutes } from "./admin-costs.js";
import { authRoutes } from "./auth.js";
import { authDiscoverRoutes } from "./auth-discover.js";
import { badgesRoutes } from "./badges.js";
import { commentsRoutes } from "./comments.js";
import { contentDiscoveryRoutes } from "./content-discovery.js";
import { dashboardRoutes } from "./dashboard.js";
import { deletionRoutes } from "./deletion.js";
import { devicesRoutes } from "./devices.js";
import { employeesRoutes } from "./employees.js";
import { entitiesRoutes } from "./entities.js";
import { exportRoutes } from "./export.js";
import { featureFlagsRoutes } from "./feature-flags.js";
import { feedsRoutes } from "./feeds.js";
import { relationshipRoutes } from "./relationships.js";
import { circleRoutes } from "./circles.js";
import { discoveryRoutes } from "./discovery.js";
import { entityRelationshipRoutes } from "./entity-relationships.js";
import { connectionCodeRoutes } from "./connection-codes.js";
import { agentSurfaceRoutes } from "./agent-surface.js";
import { healthRoutes } from "./health.js";
import { internaldocsRoutes } from "./internal-docs.js";
import { invitationsRoutes } from "./invitations.js";
import { linkReportRoutes } from "./link-reports.js";
import { mapRoutes } from "./map.js";
import { mediaRoutes } from "./media.js";
import { mfaRoutes } from "./mfa.js";
import { mediaMetadataVisibilityRoutes } from "./media-metadata-visibility.js";
import { uploadSessionRoutes } from "./upload-sessions.js";
import { orphanedMediaRoutes } from "./orphaned-media.js";
import { orphanedMediaHealthRoutes } from "./orphaned-media-health.js";
import { outRoutes } from "./out.js";
import { postsRoutes } from "./posts.js";
import { privacyRoutes } from "./privacy.js";
import { productTaxonomyRoutes } from "./products.js";
import { notificationsRoutes } from "./notifications.js";
import { parentalControlRoutes } from "./parental-controls.js";
import { sentimentsRoutes } from "./sentiments.js";
import { settingsRoutes } from "./settings.js";
import { taxonomyRoutes } from "./taxonomy.js";
import { taxonomyAnalyticsRoutes } from "./taxonomy-analytics.js";
import type { Route } from "./types.js";
import { tenantRoutes } from "./tenants.js";
import { tenantAuditRoutes } from "./tenant-audit.js";
import { tenantComplianceRoutes } from "./tenant-compliance.js";
import { setupStatusRoutes } from "./setup-status.js";
import { tenantDomainRoutes } from "./tenant-domains.js";
import { tenantIdpRoutes } from "./tenant-idp.js";
import { tenantMemberRoutes } from "./tenant-members.js";
import { tenantRoleMappingRoutes } from "./tenant-role-mappings.js";
import { tenantClassificationRoutes } from "./tenant-classification.js";
import { tenantDirectoryProfileRoutes } from "./tenant-directory-profile.js";
import { tenantDirectorySearchRoutes } from "./tenant-directory-search.js";
import { platformCategoryAdminRoutes } from "./platform-category-admin.js";
import { userRoutes } from "./user.js";
import { oauthRoutes } from "./oauth.js";
import { agentAuthorizeRoutes } from "./agent-authorize.js";
import { agentSessionsRoutes } from "./agent-sessions.js";

/**
 * G4 MEDIUM-3: mark every route in `routes` as `publicSpec: true` so it
 * appears in the auto-generated OpenAPI document. Routes left without
 * the flag are excluded from `/openapi.json`. The federation surface
 * and the agent-integration discovery routes are the curated public
 * spec; non-federation routes (posts, comments, media, ActivityPub,
 * extensions, etc.) are intentionally omitted.
 */
function markPublicSpec(routes: Route[]): Route[] {
  return routes.map((r) => ({ ...r, publicSpec: true }));
}

/**
 * Master switch for ActivityPub federation, read once at module load (the value
 * is a deploy-time constant). When false, the federation-facing routes below are
 * never registered, so a federation-disabled deploy exposes no actor / inbox /
 * outbox / public AP-object surface — even to a request that bypasses CloudFront
 * by hitting an internet-facing ALB directly. Mirrors `env.ACTIVITYPUB_ENABLED`.
 */
const activityPubEnabled = process.env.ACTIVITYPUB_ENABLED === "true";

/**
 * Authenticated app endpoints (e.g. the `/api/messages` DM API and
 * `/api/audiences` API) live in the same route modules as the public,
 * federation-facing AP-object endpoints (`/messages/:id`, `/audiences/:id`).
 * Keep the `/api/*` endpoints always on; gate only the federation-facing ones.
 */
const appOnly = (route: Route): boolean =>
  activityPubEnabled ||
  (typeof route.path === "string" && route.path.startsWith("/api/"));

/**
 * Core routes — domain-agnostic functionality.
 * Extension routes are merged below.
 */
const coreRoutes: Route[] = [
  // Health and configuration (highest priority)
  ...healthRoutes,

  // Agent discovery surface (T9b-a): /llms.txt, /openapi.json, /security.txt
  ...markPublicSpec(agentSurfaceRoutes),

  // Authentication
  ...authRoutes,

  // Sign-in discovery (pre-login, no auth required)
  ...markPublicSpec(authDiscoverRoutes),

  // MFA (multi-factor authentication)
  ...mfaRoutes,

  // User profile management
  ...userRoutes,

  // Tenant CRUD + auth switch
  ...markPublicSpec(tenantRoutes),

  // Tenant domain verification
  ...markPublicSpec(tenantDomainRoutes),

  // Tenant identity provider (OIDC)
  ...markPublicSpec(tenantIdpRoutes),

  // Tenant members (list/patch role/remove)
  ...markPublicSpec(tenantMemberRoutes),

  // Tenant role mappings (CRUD)
  ...markPublicSpec(tenantRoleMappingRoutes),

  // Tenant classification (org-category self-declaration) — T1
  ...tenantClassificationRoutes,

  // Tenant directory profile (discoverability + location precision) — T3
  ...tenantDirectoryProfileRoutes,

  // Directory search (name/category/location, triangulation-safe) — T4
  ...tenantDirectorySearchRoutes,

  // Platform category admin (SUPER_ADMIN-only taxonomy management) — T5
  ...platformCategoryAdminRoutes,

  // Tenant audit log
  ...markPublicSpec(tenantAuditRoutes),

  // Tenant compliance bundle (T9b-e)
  ...markPublicSpec(tenantComplianceRoutes),

  // Tenant setup-status (T9b-b)
  ...markPublicSpec(setupStatusRoutes),

  // OAuth device-authorization adapter (T9b-d, RFC 8628)
  ...markPublicSpec(oauthRoutes),

  // Agent-authorize page (HTML approval flow)
  ...markPublicSpec(agentAuthorizeRoutes),

  // User-facing agent sessions (list + revoke)
  ...markPublicSpec(agentSessionsRoutes),

  // Internal documentation
  ...internaldocsRoutes,

  // Orphaned media health monitoring (must be before admin wildcard routes)
  ...orphanedMediaHealthRoutes,

  // Admin routes (super-admin, feature toggles, role metadata)
  ...adminCostRoutes,
  ...adminRoutes,

  // Dashboard routes (internal dashboard, partner dashboard, user management)
  ...dashboardRoutes,

  // Badges
  ...badgesRoutes,

  // Employees
  ...employeesRoutes,

  // Invitations
  ...invitationsRoutes,

  // Map
  ...mapRoutes,

  // Entities (replaces Dogs for white-label support)
  ...entitiesRoutes,

  // Feeds
  ...feedsRoutes,

  // Posts
  ...postsRoutes,

  // Comments
  ...commentsRoutes,

  // Sentiments/Reactions
  ...sentimentsRoutes,
  // Realtime / server-blind settings sync
  ...settingsRoutes,

  // Media uploads
  ...mediaRoutes,

  // Media metadata privacy controls
  ...mediaMetadataVisibilityRoutes,

  // Upload sessions (optimistic image uploads)
  ...uploadSessionRoutes,

  // Orphaned media management
  ...orphanedMediaRoutes,

  // Privacy preferences
  ...privacyRoutes,

  // Notifications (Safer Social Design)
  ...notificationsRoutes,

  // Push device registration (T8 — see lib/doc/push-device-contract.md)
  ...devicesRoutes,

  // Parental Controls (Safer Social Design)
  ...parentalControlRoutes,

  // User export
  ...exportRoutes,

  // Account deletion
  ...deletionRoutes,

  // Relationships (circles model — replaces followers and the legacy
  // KV-backed friends endpoints, which were removed in the pre-launch
  // schema end-state pass; see lib/friend-ids.ts)
  ...relationshipRoutes,

  // Circles (content views)
  ...circleRoutes,

  // Entity Relationships (entity-to-entity)
  ...entityRelationshipRoutes,

  // Connection Codes
  ...connectionCodeRoutes,

  // Discovery
  ...discoveryRoutes,

  // Taxonomy
  ...taxonomyRoutes,

  // Content Discovery
  ...contentDiscoveryRoutes,

  // Taxonomy Analytics
  ...taxonomyAnalyticsRoutes,

  // Product Taxonomy Tags
  ...productTaxonomyRoutes,

  // Feature Flags
  ...featureFlagsRoutes,

  // Link Reports
  ...linkReportRoutes,

  // Out Redirector (public endpoint, must be before 404 handler)
  ...outRoutes,

  // ActivityPub routes (public endpoints, must be before 404 handler).
  // Note: these use /users/:username and /posts/:postId patterns (no /api prefix)
  // and are unauthenticated (inbox is signature-verified, the rest are public).
  // Registered ONLY when federation is enabled — see `activityPubEnabled` above.
  // WebFinger must be early for actor discovery.
  ...(activityPubEnabled
    ? [
        ...webfingerRoutes,
        ...actorRoutes,
        ...inboxRoutes,
        ...outboxRoutes,
        ...friendsRoutes,
        ...groupRoutes,
        ...collectionRoutes,
        ...entityProfileRoutes,
        ...activitypubPostRoutes,
      ]
    : []),

  // Direct messages: authenticated `/api/messages*` endpoints are always on;
  // the public AP-object form (`/messages/:messageId`, no auth) is gated.
  ...messageRoutes.filter(appOnly),

  // Custom audiences: authenticated `/api/audiences*` always on; the public
  // collection (`/audiences/:audienceId`) is gated.
  ...audienceRoutes.filter(appOnly),
];

// Merge extension routes (after core, before 404)
import { getExtensions } from "../../extensions.js";
import { wrapExtensionRoutes } from "../extension-route-wrapper.js";

const extensionRoutes: Route[] = [
  // Raw routes (legacy — app-side wired handlers)
  ...getExtensions().flatMap((ext) => ext.routes as Route[]),
  // Core-wrapped routes (clean pattern — extension provides handler, core wraps)
  ...getExtensions().flatMap((ext) => wrapExtensionRoutes(ext)),
];

export const routes: Route[] = [
  ...coreRoutes,
  ...extensionRoutes,

  // 404 handler - must be last
  {
    path: "*",
    method: "*",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      return securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    },
    middleware: [corsMiddleware()],
    description: "404 Not Found",
  },
];

// Re-export types
export type { Route } from "./types.js";
