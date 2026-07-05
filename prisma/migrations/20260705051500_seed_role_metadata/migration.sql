-- Seed role metadata (upsert for idempotency). Data-only migration — carried
-- over from the pre-endstate 20260412080000_seed_role_metadata, plus the
-- MODERATOR row that migration predated (Surveillance-hardening Phase 0, E5,
-- added the enum value but the seed was never extended — fixed here as part
-- of the pre-launch schema end-state pass).
INSERT INTO "role_metadata" ("role", "display_name", "description", "category", "permissions", "is_active", "created_at", "updated_at")
VALUES
  ('END_USER', 'End User', 'Standard user with basic access to create posts, follow users, and interact with content.', 'end_user', '{"canCreatePosts":true,"canFollowUsers":true,"canComment":true,"canLike":true}', true, NOW(), NOW()),
  ('B2B_PARTNER', 'B2B Partner', 'Business partner with access to partner-specific features and analytics.', 'partner', '{"canCreatePosts":true,"canAccessPartnerDashboard":true,"canViewAnalytics":true}', true, NOW(), NOW()),
  ('PARTNER_ADMIN', 'Partner Administrator', 'Administrator for a business partner with full access to partner management features.', 'partner', '{"canCreatePosts":true,"canAccessPartnerDashboard":true,"canManagePartnerUsers":true,"canViewAnalytics":true,"canManagePartnerSettings":true}', true, NOW(), NOW()),
  ('INTERNAL', 'Internal Staff', 'Internal team member with access to internal tools and administrative features.', 'internal', '{"canCreatePosts":true,"canAccessInternalDashboard":true,"canViewAnalytics":true,"canManageContent":true}', true, NOW(), NOW()),
  ('CONTENT_CREATOR', 'Content Creator', 'Content creator with enhanced posting capabilities and content management features.', 'system', '{"canCreatePosts":true,"canCreateAdvancedContent":true,"canSchedulePosts":true,"canViewContentAnalytics":true}', true, NOW(), NOW()),
  ('MODERATOR', 'Moderator', 'Moderation-queue access: review reported content and media held for review. No user or system management.', 'internal', '{"canCreatePosts":true,"canAccessModerationQueue":true,"canReviewReports":true,"canReviewMedia":true}', true, NOW(), NOW()),
  ('SUPER_ADMIN', 'Super Administrator', 'System administrator with full access to all features and administrative capabilities.', 'system', '{"canCreatePosts":true,"canAccessAdminDashboard":true,"canManageUsers":true,"canManageSystemSettings":true,"canViewAllAnalytics":true,"canManageRoles":true}', true, NOW(), NOW())
ON CONFLICT ("role") DO UPDATE SET
  "display_name" = EXCLUDED."display_name",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "permissions" = EXCLUDED."permissions",
  "updated_at" = NOW();
