-- ============================================================================
-- init — single clean pre-launch migration (schema end-state pass, 2026-07).
-- Replaces the 14 accumulated pre-launch migrations; nothing was live, so no
-- data migration is carried. Hand-written SQL (extensions, partial unique
-- indexes, GIN/GiST indexes) lives at the top/bottom of this file — it is NOT
-- derivable from schema.prisma. See doc/02-technical/database/.
-- ============================================================================

-- Extensions.
--   postgis: entity_location.location geography column + GiST proximity
--     indexes (ST_DWithin / KNN). NOT an RDS "trusted extension" — requires
--     rds_superuser. Migrations run as the RDS master user (a member of
--     rds_superuser), so in-migration creation works; if migrations are ever
--     moved to a lesser role, move this to the master-run bootstrap step
--     (see the prod bootstrap runbook).
--   pg_trgm: typo-tolerant directory search (trigram GIN indexes below).
--     Trusted extension on RDS PG13+ (CREATE privilege suffices).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'MEMORIAL', 'TRANSFERRED');

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'REVIEW', 'QUARANTINED', 'REJECTED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('END_USER', 'B2B_PARTNER', 'PARTNER_ADMIN', 'INTERNAL', 'CONTENT_CREATOR', 'MODERATOR', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "SignupMethod" AS ENUM ('COGNITO', 'INVITE', 'MAGIC_LINK');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('LINK', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('CROSS_REGION', 'RESEARCH_OBSERVATION', 'RESEARCH_PARTICIPATION');

-- CreateEnum
CREATE TYPE "PostRadius" AS ENUM ('WHISPER', 'NORMAL', 'LOUD', 'SHOUT');

-- CreateEnum
CREATE TYPE "Privacy" AS ENUM ('PUBLIC', 'FOLLOWERS', 'PRIVATE');

-- CreateEnum
CREATE TYPE "ModerationTrack" AS ENUM ('VISUAL', 'AUDIO');

-- CreateEnum
CREATE TYPE "OwnershipRole" AS ENUM ('PRIMARY_OWNER', 'CO_OWNER', 'CARETAKER');

-- CreateEnum
CREATE TYPE "OwnershipStatus" AS ENUM ('ACTIVE', 'REMOVED', 'LEFT');

-- CreateEnum
CREATE TYPE "GroupPrivacy" AS ENUM ('PUBLIC', 'PRIVATE', 'FRIENDS_ONLY');

-- CreateEnum
CREATE TYPE "GroupRole" AS ENUM ('MEMBER', 'MODERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "AgeTier" AS ENUM ('CHILD', 'TEEN', 'ADULT');

-- CreateEnum
CREATE TYPE "ProfileVisibility" AS ENUM ('PUBLIC', 'CONNECTIONS', 'PRIVATE');

-- CreateEnum
CREATE TYPE "DmAccess" AS ENUM ('ANYONE', 'CONNECTIONS', 'NOBODY');

-- CreateEnum
CREATE TYPE "ParentalLinkStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DIRECT_MESSAGE', 'SAFETY_ALERT', 'PARENTAL_LINK', 'FOLLOW', 'SENTIMENT_DIGEST', 'SYSTEM', 'RELATIONSHIP_CREATED', 'RELATIONSHIP_RECIPROCATED', 'TIER_CHANGED', 'ENTITY_RELATIONSHIP_PROPOSED', 'ENTITY_RELATIONSHIP_CONFIRMED', 'CONNECTION_CODE_REDEEMED');

-- CreateEnum
CREATE TYPE "TenantType" AS ENUM ('PERSONAL', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETING');

-- CreateEnum
CREATE TYPE "TenantRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'GUEST');

-- CreateEnum
CREATE TYPE "TenantMemberStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "IdpKind" AS ENUM ('SAML', 'OIDC');

-- CreateEnum
CREATE TYPE "IdpStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED', 'ERROR');

-- CreateEnum
CREATE TYPE "VerificationSource" AS ENUM ('SELF_DECLARED', 'TECHSOUP', 'HAUS_DES_STIFTENS', 'PLATFORM_MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "LocationPrecision" AS ENUM ('EXACT', 'NEIGHBORHOOD', 'CITY', 'HIDDEN');

-- CreateEnum
CREATE TYPE "EntityRelationshipStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateTable
CREATE TABLE "entities" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entity_type" TEXT,
    "metadata" JSONB,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "deceased_at" TIMESTAMP(3),
    "memorial_settings" JSONB,
    "life_stage" TEXT,
    "life_stage_manual_override" BOOLEAN NOT NULL DEFAULT false,
    "life_stage_calculated_at" TIMESTAMP(3),
    "actor_uri" TEXT,
    "inbox_url" TEXT,
    "outbox_url" TEXT,
    "followers_url" TEXT,
    "public_key" TEXT,
    "private_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_geo_index" (
    "post_uri" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "entity_ref" TEXT,
    "geohash" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "place" TEXT,
    "labels" JSONB DEFAULT '[]',

    CONSTRAINT "post_geo_index_pkey" PRIMARY KEY ("post_uri")
);

-- CreateTable
CREATE TABLE "entity_location" (
    "entity_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "location" geography(Point, 4326) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_location_pkey" PRIMARY KEY ("entity_id")
);

-- CreateTable
CREATE TABLE "role_metadata" (
    "role" "UserRole" NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "permissions" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_metadata_pkey" PRIMARY KEY ("role")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'END_USER',
    "actor_uri" TEXT,
    "handle" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cognito_sub" TEXT,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "suspended_at" TIMESTAMP(3),
    "suspended_reason" TEXT,
    "personal_tenant_id" TEXT,
    "deletion_requested_at" TIMESTAMP(3),
    "deletion_scheduled_at" TIMESTAMP(3),
    "deletion_confirmed_at" TIMESTAMP(3),
    "username" TEXT,
    "stealth_mode" BOOLEAN NOT NULL DEFAULT false,
    "show_online_status" BOOLEAN NOT NULL DEFAULT true,
    "show_typing_indicator" BOOLEAN NOT NULL DEFAULT true,
    "show_last_seen" BOOLEAN NOT NULL DEFAULT true,
    "location_tracking_enabled" BOOLEAN NOT NULL DEFAULT true,
    "location_anonymization_level" INTEGER NOT NULL DEFAULT 0,
    "analytics_opt_out" BOOLEAN NOT NULL DEFAULT false,
    "signup_method" "SignupMethod",
    "invitation_id" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "email_verified_at" TIMESTAMP(3),
    "show_verified_badge" BOOLEAN NOT NULL DEFAULT true,
    "identity_verified" BOOLEAN NOT NULL DEFAULT false,
    "identity_verified_at" TIMESTAMP(3),
    "identity_verification_method" TEXT,
    "identity_verification_provider" TEXT,
    "show_identity_verified_badge" BOOLEAN NOT NULL DEFAULT true,
    "region" TEXT NOT NULL DEFAULT 'EU',
    "data_region" TEXT,
    "inbox_url" TEXT,
    "outbox_url" TEXT,
    "followers_url" TEXT,
    "following_url" TEXT,
    "friends_url" TEXT,
    "public_key" TEXT,
    "private_key" TEXT,
    "anonymous_id" TEXT,
    "date_of_birth" TIMESTAMP(3),
    "age_tier" "AgeTier" NOT NULL DEFAULT 'ADULT',
    "age_verified" BOOLEAN NOT NULL DEFAULT false,
    "quiet_hours_start" INTEGER,
    "quiet_hours_end" INTEGER,
    "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
    "profile_visibility" "ProfileVisibility" NOT NULL DEFAULT 'PUBLIC',
    "dm_access" "DmAccess" NOT NULL DEFAULT 'CONNECTIONS',

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_enrollments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "encrypted_secret" TEXT NOT NULL,
    "backup_codes" TEXT[],
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "mfa_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL DEFAULT 'CROSS_REGION',
    "study_id" TEXT,
    "data_region" TEXT,
    "access_region" TEXT,
    "consented" BOOLEAN NOT NULL DEFAULT false,
    "consented_at" TIMESTAMP(3),
    "withdrawn_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "user_agent" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "superseded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "radius" "PostRadius" NOT NULL DEFAULT 'NORMAL',
    "geo_data" JSONB,
    "uri" TEXT,
    "content_warnings" TEXT[],
    "deleted_at" TIMESTAMP(3),
    "hidden_by_author" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "edited_at" TIMESTAMP(3),
    "group_id" TEXT,
    "primary_entity_id" TEXT,
    "data_region" TEXT,
    "activity_id" TEXT,
    "object_id" TEXT,
    "to" JSONB,
    "cc" JSONB,
    "bto" JSONB,
    "bcc" JSONB,
    "published" TIMESTAMP(3),
    "has_blocked_links" BOOLEAN NOT NULL DEFAULT false,
    "author_org_root_category_code" TEXT,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_files" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "content_hash" TEXT,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "upload_id" TEXT,
    "original_key" TEXT,
    "thumbnail_key" TEXT,
    "optimized_key" TEXT,
    "moderation_status" "ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "width" INTEGER,
    "height" INTEGER,
    "duration" INTEGER,
    "exif_data" JSONB,
    "iptc_data" JSONB,
    "video_metadata" JSONB,
    "date_taken" TIMESTAMP(3),
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata_visible" BOOLEAN NOT NULL DEFAULT false,
    "location_visible" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "hidden_at" TIMESTAMP(3),
    "hidden_by" TEXT,
    "upload_status" TEXT NOT NULL DEFAULT 'PENDING',
    "uploaded_by" TEXT,
    "attached_to_post" BOOLEAN NOT NULL DEFAULT false,
    "orphaned_at" TIMESTAMP(3),
    "last_accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "media_ids" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_moderation_jobs" (
    "id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "track" "ModerationTrack" NOT NULL,
    "job_id" TEXT NOT NULL,
    "decision" TEXT,
    "threshold_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_moderation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_moderation_messages" (
    "id" TEXT NOT NULL,
    "message_dedupe_key" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_moderation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_media" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "alt" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "post_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_sentiments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "post_uri" TEXT,
    "author_id" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_sentiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_comments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "post_uri" TEXT,
    "author_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "root_uri" TEXT,
    "reply_to_uri" TEXT,
    "hidden_by_post_owner" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),
    "original_text" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,
    "has_blocked_links" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "post_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_comment_media" (
    "id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "alt" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "post_comment_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_sentiments" (
    "id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "comment_uri" TEXT,
    "author_id" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_sentiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_subjects" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "userId" TEXT,
    "tenant_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "details" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retention_until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "tenant_id" TEXT,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_kind" TEXT,
    "resource_id" TEXT,
    "outcome" TEXT NOT NULL,
    "failure_reason" TEXT,
    "severity" TEXT NOT NULL,
    "request_id" TEXT,
    "trace_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "retention_until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_toggles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "tenant_id" TEXT,
    "changed_by" TEXT,
    "last_changed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_toggles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "email" TEXT,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "used_by" TEXT,
    "used_at" TIMESTAMP(3),
    "scanned_at" TIMESTAMP(3),
    "scanned_by" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxonomy_dimensions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "taxonomy_dimensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxonomy_categories" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "dimension_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "taxonomy_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxonomy_taxons" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "taxonId" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "synonyms" JSONB,
    "userTerms" JSONB,
    "parent_taxon_id" TEXT,
    "translations" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "taxonomy_taxons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_taxonomy_tags" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "taxon_id" TEXT NOT NULL,
    "added_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_taxonomy_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_taxonomy_tags" (
    "id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "taxon_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_taxonomy_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_taxonomy_tags" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "taxon_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_taxonomy_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_ownerships" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "OwnershipRole" NOT NULL DEFAULT 'CO_OWNER',
    "added_by_user_id" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "OwnershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "entity_ownerships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circle_configs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "inner_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "close_friend_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "community_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "daily_deck_size" INTEGER,
    "glance_limit" INTEGER NOT NULL DEFAULT 20,
    "depth_window_days" INTEGER NOT NULL DEFAULT 7,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "circle_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circle_read_states" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "last_read_at" TIMESTAMP(3) NOT NULL,
    "last_read_post_id" TEXT,
    "caught_up" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "circle_read_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "actor_uri" TEXT NOT NULL,
    "inbox_url" TEXT NOT NULL,
    "outbox_url" TEXT NOT NULL,
    "followers_url" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "private_key" TEXT NOT NULL,
    "privacy" "GroupPrivacy" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "actor_uri" TEXT NOT NULL,
    "role" "GroupRole" NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" TEXT NOT NULL,
    "actor_uri" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "object_id" TEXT,
    "target_id" TEXT,
    "to" JSONB,
    "cc" JSONB,
    "bto" JSONB,
    "bcc" JSONB,
    "published" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inbox_actor_uri" TEXT,
    "outbox_actor_uri" TEXT,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "direct_messages" (
    "id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "object_id" TEXT,
    "activity_id" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "direct_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_audiences" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_audience_members" (
    "id" TEXT NOT NULL,
    "audience_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_audience_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_reputations" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "reputation" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "last_checked" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domain_reputations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_checks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "post_id" TEXT,
    "comment_id" TEXT,
    "original_url" TEXT NOT NULL,
    "normalized_url" TEXT NOT NULL,
    "final_url" TEXT,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "check_type" TEXT NOT NULL,
    "threat_intel" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_at" TIMESTAMP(3),

    CONSTRAINT "link_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interaction_events" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "interaction_type" TEXT NOT NULL,
    "tenant_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interaction_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "report_type" "ReportType" NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "reporter_user_id" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "domain" TEXT,
    "assignee_user_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "bounceType" TEXT,
    "suppressedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "items_deleted" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deletion_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parental_links" (
    "id" TEXT NOT NULL,
    "child_id" TEXT NOT NULL,
    "guardian_id" TEXT NOT NULL,
    "status" "ParentalLinkStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "parental_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "batch_id" TEXT,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "dm_enabled" BOOLEAN NOT NULL DEFAULT true,
    "follow_enabled" BOOLEAN NOT NULL DEFAULT true,
    "digest_enabled" BOOLEAN NOT NULL DEFAULT true,
    "system_enabled" BOOLEAN NOT NULL DEFAULT true,
    "relationship_enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_codes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "entity_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "max_uses" INTEGER NOT NULL,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_code_redemptions" (
    "id" TEXT NOT NULL,
    "code_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_code_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "type" "TenantType" NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "region" TEXT NOT NULL DEFAULT 'EU',
    "personal_owner_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "suspended_at" TIMESTAMP(3),
    "suspend_reason" TEXT,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_members" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,
    "status" "TenantMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_jit_provisioned" BOOLEAN NOT NULL DEFAULT false,
    "invited_by_user_id" TEXT,
    "invited_at" TIMESTAMP(3),
    "joined_at" TIMESTAMP(3),
    "removed_at" TIMESTAMP(3),
    "last_active_at" TIMESTAMP(3),

    CONSTRAINT "tenant_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_domains" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "verification_token" TEXT NOT NULL,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "verify_attempted_at" TIMESTAMP(3),
    "verify_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_identity_providers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" "IdpKind" NOT NULL,
    "cognito_idp_name" TEXT NOT NULL,
    "metadata_url" TEXT,
    "metadata_xml" TEXT,
    "issuer_url" TEXT,
    "client_id" TEXT,
    "client_secret_arn" TEXT,
    "scopes" TEXT NOT NULL DEFAULT 'openid email profile groups',
    "attribute_mapping" JSONB NOT NULL DEFAULT '{}',
    "default_role" "TenantRole",
    "status" "IdpStatus" NOT NULL DEFAULT 'PENDING',
    "enabled_at" TIMESTAMP(3),
    "last_error" TEXT,
    "last_error_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_identity_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_role_mappings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "idp_group_name" TEXT NOT NULL,
    "tenant_role" "TenantRole" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_role_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_invitations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "accepted_by_user_id" TEXT,
    "invited_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "synonyms" JSONB,
    "translations" JSONB,
    "parent_category_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_classifications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "verification_source" "VerificationSource" NOT NULL DEFAULT 'SELF_DECLARED',
    "verified_at" TIMESTAMP(3),
    "verified_by_ref" TEXT,
    "verification_revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_classification_tags" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "classification_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,

    CONSTRAINT "tenant_classification_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_directory_profiles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "is_discoverable" BOOLEAN NOT NULL DEFAULT false,
    "short_description" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "displayLat" DOUBLE PRECISION,
    "displayLng" DOUBLE PRECISION,
    "location_label" TEXT,
    "location_precision" "LocationPrecision" NOT NULL DEFAULT 'CITY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_directory_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationships" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "computed_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "manual_score" DOUBLE PRECISION,
    "tier" INTEGER NOT NULL DEFAULT 3,
    "interaction_count" INTEGER NOT NULL DEFAULT 0,
    "last_interaction_at" TIMESTAMP(3),
    "connection_method" TEXT NOT NULL,
    "reciprocated" BOOLEAN NOT NULL DEFAULT false,
    "signals" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_relationships" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "related_entity_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "EntityRelationshipStatus" NOT NULL DEFAULT 'PENDING',
    "proposed_by_user_id" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encrypted_user_settings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encrypted_user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocked_users" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "blocker_id" TEXT NOT NULL,
    "blocked_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "entities_actor_uri_key" ON "entities"("actor_uri");

-- CreateIndex
CREATE INDEX "entities_tenant_id_entity_type_status_idx" ON "entities"("tenant_id", "entity_type", "status");

-- CreateIndex
CREATE INDEX "post_geo_index_tenant_id_idx" ON "post_geo_index"("tenant_id");

-- CreateIndex
CREATE INDEX "post_geo_index_entity_ref_idx" ON "post_geo_index"("entity_ref");

-- CreateIndex
CREATE INDEX "post_geo_index_geohash_idx" ON "post_geo_index"("geohash");

-- CreateIndex
CREATE INDEX "entity_location_tenant_id_idx" ON "entity_location"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_actor_uri_key" ON "users"("actor_uri");

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "users_cognito_sub_key" ON "users"("cognito_sub");

-- CreateIndex
CREATE UNIQUE INDEX "users_personal_tenant_id_key" ON "users"("personal_tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_anonymous_id_key" ON "users"("anonymous_id");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_invitation_id_idx" ON "users"("invitation_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_enrollments_user_id_key" ON "mfa_enrollments"("user_id");

-- CreateIndex
CREATE INDEX "consent_user_id_purpose_active_idx" ON "consent"("user_id", "purpose", "active");

-- CreateIndex
CREATE UNIQUE INDEX "consent_user_id_purpose_study_id_key" ON "consent"("user_id", "purpose", "study_id");

-- CreateIndex
CREATE UNIQUE INDEX "posts_activity_id_key" ON "posts"("activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "posts_object_id_key" ON "posts"("object_id");

-- CreateIndex
CREATE INDEX "posts_tenant_id_created_at_idx" ON "posts"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "posts_author_id_created_at_idx" ON "posts"("author_id", "created_at");

-- CreateIndex
CREATE INDEX "posts_author_id_radius_created_at_idx" ON "posts"("author_id", "radius", "created_at");

-- CreateIndex
CREATE INDEX "posts_primary_entity_id_idx" ON "posts"("primary_entity_id");

-- CreateIndex
CREATE INDEX "posts_created_at_idx" ON "posts"("created_at");

-- CreateIndex
CREATE INDEX "posts_group_id_idx" ON "posts"("group_id");

-- CreateIndex
CREATE INDEX "posts_author_org_root_category_code_created_at_idx" ON "posts"("author_org_root_category_code", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_files_upload_id_key" ON "media_files"("upload_id");

-- CreateIndex
CREATE INDEX "media_files_moderation_status_idx" ON "media_files"("moderation_status");

-- CreateIndex
CREATE INDEX "media_files_created_at_idx" ON "media_files"("created_at");

-- CreateIndex
CREATE INDEX "media_files_upload_status_idx" ON "media_files"("upload_status");

-- CreateIndex
CREATE INDEX "media_files_uploaded_by_idx" ON "media_files"("uploaded_by");

-- CreateIndex
CREATE INDEX "media_files_attached_to_post_created_at_idx" ON "media_files"("attached_to_post", "created_at");

-- CreateIndex
CREATE INDEX "media_files_orphaned_at_idx" ON "media_files"("orphaned_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_files_tenant_id_content_hash_key" ON "media_files"("tenant_id", "content_hash");

-- CreateIndex
CREATE INDEX "upload_sessions_user_id_status_idx" ON "upload_sessions"("user_id", "status");

-- CreateIndex
CREATE INDEX "upload_sessions_expires_at_idx" ON "upload_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_moderation_jobs_job_id_key" ON "media_moderation_jobs"("job_id");

-- CreateIndex
CREATE INDEX "media_moderation_jobs_media_id_idx" ON "media_moderation_jobs"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "processed_moderation_messages_message_dedupe_key_key" ON "processed_moderation_messages"("message_dedupe_key");

-- CreateIndex
CREATE INDEX "post_media_tenant_id_idx" ON "post_media"("tenant_id");

-- CreateIndex
CREATE INDEX "post_media_media_id_idx" ON "post_media"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_media_post_id_media_id_key" ON "post_media"("post_id", "media_id");

-- CreateIndex
CREATE INDEX "post_sentiments_author_id_idx" ON "post_sentiments"("author_id");

-- CreateIndex
CREATE INDEX "post_sentiments_post_id_created_at_idx" ON "post_sentiments"("post_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_post_sentiment_pagination" ON "post_sentiments"("post_id", "sentiment", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "post_sentiments_tenant_id_idx" ON "post_sentiments"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_sentiments_post_id_author_id_key" ON "post_sentiments"("post_id", "author_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_sentiments_post_uri_author_id_key" ON "post_sentiments"("post_uri", "author_id");

-- CreateIndex
CREATE INDEX "post_comments_tenant_id_idx" ON "post_comments"("tenant_id");

-- CreateIndex
CREATE INDEX "post_comments_post_id_created_at_idx" ON "post_comments"("post_id", "created_at");

-- CreateIndex
CREATE INDEX "post_comments_post_uri_created_at_idx" ON "post_comments"("post_uri", "created_at");

-- CreateIndex
CREATE INDEX "post_comments_author_id_idx" ON "post_comments"("author_id");

-- CreateIndex
CREATE INDEX "post_comments_reply_to_uri_idx" ON "post_comments"("reply_to_uri");

-- CreateIndex
CREATE INDEX "post_comments_root_uri_created_at_idx" ON "post_comments"("root_uri", "created_at");

-- CreateIndex
CREATE INDEX "post_comments_post_id_root_uri_idx" ON "post_comments"("post_id", "root_uri");

-- CreateIndex
CREATE INDEX "post_comment_media_media_id_idx" ON "post_comment_media"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_comment_media_comment_id_media_id_key" ON "post_comment_media"("comment_id", "media_id");

-- CreateIndex
CREATE INDEX "comment_sentiments_author_id_idx" ON "comment_sentiments"("author_id");

-- CreateIndex
CREATE INDEX "comment_sentiments_comment_id_sentiment_idx" ON "comment_sentiments"("comment_id", "sentiment");

-- CreateIndex
CREATE INDEX "comment_sentiments_comment_id_created_at_idx" ON "comment_sentiments"("comment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "comment_sentiments_comment_id_author_id_key" ON "comment_sentiments"("comment_id", "author_id");

-- CreateIndex
CREATE UNIQUE INDEX "comment_sentiments_comment_uri_author_id_key" ON "comment_sentiments"("comment_uri", "author_id");

-- CreateIndex
CREATE INDEX "post_subjects_entity_id_created_at_idx" ON "post_subjects"("entity_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "post_subjects_post_id_entity_id_key" ON "post_subjects"("post_id", "entity_id");

-- CreateIndex
CREATE INDEX "security_events_type_idx" ON "security_events"("type");

-- CreateIndex
CREATE INDEX "security_events_severity_idx" ON "security_events"("severity");

-- CreateIndex
CREATE INDEX "security_events_timestamp_idx" ON "security_events"("timestamp");

-- CreateIndex
CREATE INDEX "security_events_userId_idx" ON "security_events"("userId");

-- CreateIndex
CREATE INDEX "security_events_tenant_id_idx" ON "security_events"("tenant_id");

-- CreateIndex
CREATE INDEX "security_events_ip_address_idx" ON "security_events"("ip_address");

-- CreateIndex
CREATE INDEX "security_events_retention_until_idx" ON "security_events"("retention_until");

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_idx" ON "audit_event"("tenant_id");

-- CreateIndex
CREATE INDEX "audit_event_timestamp_idx" ON "audit_event"("timestamp");

-- CreateIndex
CREATE INDEX "audit_event_action_idx" ON "audit_event"("action");

-- CreateIndex
CREATE INDEX "audit_event_retention_until_idx" ON "audit_event"("retention_until");

-- CreateIndex
CREATE INDEX "feature_toggles_tenant_id_idx" ON "feature_toggles"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "feature_toggles_key_tenant_id_key" ON "feature_toggles"("key", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_code_key" ON "invitations"("code");

-- CreateIndex
CREATE INDEX "invitations_created_by_created_at_idx" ON "invitations"("created_by", "created_at");

-- CreateIndex
CREATE INDEX "invitations_used_by_idx" ON "invitations"("used_by");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE INDEX "invitations_expires_at_idx" ON "invitations"("expires_at");

-- CreateIndex
CREATE INDEX "taxonomy_dimensions_tenant_id_is_active_idx" ON "taxonomy_dimensions"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomy_dimensions_tenant_id_code_key" ON "taxonomy_dimensions"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "taxonomy_categories_tenant_id_is_active_idx" ON "taxonomy_categories"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomy_categories_tenant_id_dimension_id_code_key" ON "taxonomy_categories"("tenant_id", "dimension_id", "code");

-- CreateIndex
CREATE INDEX "taxonomy_taxons_tenant_id_category_id_idx" ON "taxonomy_taxons"("tenant_id", "category_id");

-- CreateIndex
CREATE INDEX "taxonomy_taxons_tenant_id_is_active_idx" ON "taxonomy_taxons"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "taxonomy_taxons_parent_taxon_id_idx" ON "taxonomy_taxons"("parent_taxon_id");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomy_taxons_tenant_id_taxonId_key" ON "taxonomy_taxons"("tenant_id", "taxonId");

-- CreateIndex
CREATE INDEX "post_taxonomy_tags_taxon_id_idx" ON "post_taxonomy_tags"("taxon_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_taxonomy_tags_post_id_taxon_id_key" ON "post_taxonomy_tags"("post_id", "taxon_id");

-- CreateIndex
CREATE INDEX "entity_taxonomy_tags_taxon_id_idx" ON "entity_taxonomy_tags"("taxon_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_taxonomy_tags_entity_id_taxon_id_key" ON "entity_taxonomy_tags"("entity_id", "taxon_id");

-- CreateIndex
CREATE INDEX "product_taxonomy_tags_tenant_id_idx" ON "product_taxonomy_tags"("tenant_id");

-- CreateIndex
CREATE INDEX "product_taxonomy_tags_product_id_idx" ON "product_taxonomy_tags"("product_id");

-- CreateIndex
CREATE INDEX "product_taxonomy_tags_taxon_id_idx" ON "product_taxonomy_tags"("taxon_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_taxonomy_tags_product_id_taxon_id_key" ON "product_taxonomy_tags"("product_id", "taxon_id");

-- CreateIndex
CREATE INDEX "entity_ownerships_tenant_id_idx" ON "entity_ownerships"("tenant_id");

-- CreateIndex
CREATE INDEX "entity_ownerships_user_id_idx" ON "entity_ownerships"("user_id");

-- CreateIndex
CREATE INDEX "entity_ownerships_entity_id_role_idx" ON "entity_ownerships"("entity_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "entity_ownerships_entity_id_user_id_key" ON "entity_ownerships"("entity_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "circle_configs_user_id_key" ON "circle_configs"("user_id");

-- CreateIndex
CREATE INDEX "circle_read_states_user_id_idx" ON "circle_read_states"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "circle_read_states_user_id_tier_key" ON "circle_read_states"("user_id", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "groups_actor_uri_key" ON "groups"("actor_uri");

-- CreateIndex
CREATE INDEX "groups_tenant_id_idx" ON "groups"("tenant_id");

-- CreateIndex
CREATE INDEX "groups_privacy_idx" ON "groups"("privacy");

-- CreateIndex
CREATE INDEX "group_members_tenant_id_idx" ON "group_members"("tenant_id");

-- CreateIndex
CREATE INDEX "group_members_actor_uri_idx" ON "group_members"("actor_uri");

-- CreateIndex
CREATE INDEX "group_members_group_id_role_idx" ON "group_members"("group_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "group_members_group_id_actor_uri_key" ON "group_members"("group_id", "actor_uri");

-- CreateIndex
CREATE INDEX "activities_actor_uri_idx" ON "activities"("actor_uri");

-- CreateIndex
CREATE INDEX "activities_inbox_actor_uri_received_at_idx" ON "activities"("inbox_actor_uri", "received_at");

-- CreateIndex
CREATE INDEX "activities_outbox_actor_uri_published_idx" ON "activities"("outbox_actor_uri", "published");

-- CreateIndex
CREATE INDEX "activities_published_idx" ON "activities"("published");

-- CreateIndex
CREATE UNIQUE INDEX "direct_messages_object_id_key" ON "direct_messages"("object_id");

-- CreateIndex
CREATE UNIQUE INDEX "direct_messages_activity_id_key" ON "direct_messages"("activity_id");

-- CreateIndex
CREATE INDEX "direct_messages_sender_id_idx" ON "direct_messages"("sender_id");

-- CreateIndex
CREATE INDEX "direct_messages_recipient_id_read_idx" ON "direct_messages"("recipient_id", "read");

-- CreateIndex
CREATE UNIQUE INDEX "custom_audiences_collection_id_key" ON "custom_audiences"("collection_id");

-- CreateIndex
CREATE INDEX "custom_audiences_creator_id_idx" ON "custom_audiences"("creator_id");

-- CreateIndex
CREATE INDEX "custom_audience_members_member_id_idx" ON "custom_audience_members"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_audience_members_audience_id_member_id_key" ON "custom_audience_members"("audience_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "domain_reputations_domain_key" ON "domain_reputations"("domain");

-- CreateIndex
CREATE INDEX "domain_reputations_status_idx" ON "domain_reputations"("status");

-- CreateIndex
CREATE INDEX "domain_reputations_reputation_idx" ON "domain_reputations"("reputation");

-- CreateIndex
CREATE INDEX "link_checks_tenant_id_idx" ON "link_checks"("tenant_id");

-- CreateIndex
CREATE INDEX "link_checks_post_id_idx" ON "link_checks"("post_id");

-- CreateIndex
CREATE INDEX "link_checks_comment_id_idx" ON "link_checks"("comment_id");

-- CreateIndex
CREATE INDEX "link_checks_domain_idx" ON "link_checks"("domain");

-- CreateIndex
CREATE INDEX "link_checks_status_idx" ON "link_checks"("status");

-- CreateIndex
CREATE INDEX "interaction_events_actor_user_id_created_at_idx" ON "interaction_events"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "interaction_events_target_type_target_id_created_at_idx" ON "interaction_events"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "interaction_events_expires_at_idx" ON "interaction_events"("expires_at");

-- CreateIndex
CREATE INDEX "reports_report_type_status_idx" ON "reports"("report_type", "status");

-- CreateIndex
CREATE INDEX "reports_resource_type_resource_id_idx" ON "reports"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "reports_reporter_user_id_idx" ON "reports"("reporter_user_id");

-- CreateIndex
CREATE INDEX "reports_domain_idx" ON "reports"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");

-- CreateIndex
CREATE INDEX "deletion_audit_logs_user_id_idx" ON "deletion_audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "parental_links_guardian_id_idx" ON "parental_links"("guardian_id");

-- CreateIndex
CREATE UNIQUE INDEX "parental_links_child_id_guardian_id_key" ON "parental_links"("child_id", "guardian_id");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_user_id_read_created_at_idx" ON "notifications"("tenant_id", "user_id", "read", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_created_at_idx" ON "notifications"("user_id", "read", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_batch_id_idx" ON "notifications"("user_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_key" ON "notification_preferences"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "connection_codes_code_key" ON "connection_codes"("code");

-- CreateIndex
CREATE INDEX "connection_codes_tenant_id_idx" ON "connection_codes"("tenant_id");

-- CreateIndex
CREATE INDEX "connection_codes_creator_id_expires_at_idx" ON "connection_codes"("creator_id", "expires_at");

-- CreateIndex
CREATE INDEX "connection_codes_entity_id_idx" ON "connection_codes"("entity_id");

-- CreateIndex
CREATE INDEX "connection_code_redemptions_user_id_idx" ON "connection_code_redemptions"("user_id");

-- CreateIndex
CREATE INDEX "connection_code_redemptions_tenant_id_idx" ON "connection_code_redemptions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "connection_code_redemptions_code_id_user_id_key" ON "connection_code_redemptions"("code_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_personal_owner_user_id_key" ON "tenants"("personal_owner_user_id");

-- CreateIndex
CREATE INDEX "tenants_type_status_idx" ON "tenants"("type", "status");

-- CreateIndex
CREATE INDEX "tenant_members_user_id_idx" ON "tenant_members"("user_id");

-- CreateIndex
CREATE INDEX "tenant_members_tenant_id_status_idx" ON "tenant_members"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "tenant_members_tenant_id_role_idx" ON "tenant_members"("tenant_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_members_tenant_id_user_id_key" ON "tenant_members"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domains_domain_key" ON "tenant_domains"("domain");

-- CreateIndex
CREATE INDEX "tenant_domains_tenant_id_idx" ON "tenant_domains"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_domains_verified_at_idx" ON "tenant_domains"("verified_at");

-- CreateIndex
CREATE INDEX "tenant_domains_token_expires_at_idx" ON "tenant_domains"("token_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_identity_providers_tenant_id_key" ON "tenant_identity_providers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_identity_providers_cognito_idp_name_key" ON "tenant_identity_providers"("cognito_idp_name");

-- CreateIndex
CREATE INDEX "tenant_identity_providers_status_idx" ON "tenant_identity_providers"("status");

-- CreateIndex
CREATE INDEX "tenant_role_mappings_tenant_id_priority_idx" ON "tenant_role_mappings"("tenant_id", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_role_mappings_tenant_id_idp_group_name_key" ON "tenant_role_mappings"("tenant_id", "idp_group_name");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_invitations_token_key" ON "tenant_invitations"("token");

-- CreateIndex
CREATE INDEX "tenant_invitations_email_idx" ON "tenant_invitations"("email");

-- CreateIndex
CREATE INDEX "tenant_invitations_expires_at_idx" ON "tenant_invitations"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_invitations_tenant_id_email_key" ON "tenant_invitations"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_categories_code_key" ON "platform_categories"("code");

-- CreateIndex
CREATE INDEX "platform_categories_parent_category_id_idx" ON "platform_categories"("parent_category_id");

-- CreateIndex
CREATE INDEX "platform_categories_is_active_idx" ON "platform_categories"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_classifications_tenant_id_key" ON "tenant_classifications"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_classifications_category_id_idx" ON "tenant_classifications"("category_id");

-- CreateIndex
CREATE INDEX "tenant_classifications_verification_source_idx" ON "tenant_classifications"("verification_source");

-- CreateIndex
CREATE INDEX "tenant_classification_tags_tenant_id_idx" ON "tenant_classification_tags"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_classification_tags_category_id_idx" ON "tenant_classification_tags"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_classification_tags_classification_id_category_id_key" ON "tenant_classification_tags"("classification_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_directory_profiles_tenant_id_key" ON "tenant_directory_profiles"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_directory_profiles_is_discoverable_idx" ON "tenant_directory_profiles"("is_discoverable");

-- CreateIndex
CREATE INDEX "relationships_target_type_target_id_idx" ON "relationships"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "relationships_user_id_tier_idx" ON "relationships"("user_id", "tier");

-- CreateIndex
CREATE INDEX "relationships_tenant_id_idx" ON "relationships"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "relationships_user_id_target_type_target_id_key" ON "relationships"("user_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "entity_relationships_entity_id_type_status_idx" ON "entity_relationships"("entity_id", "type", "status");

-- CreateIndex
CREATE INDEX "entity_relationships_related_entity_id_type_status_idx" ON "entity_relationships"("related_entity_id", "type", "status");

-- CreateIndex
CREATE INDEX "entity_relationships_tenant_id_idx" ON "entity_relationships"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_relationships_entity_id_related_entity_id_type_key" ON "entity_relationships"("entity_id", "related_entity_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "encrypted_user_settings_user_id_namespace_key" ON "encrypted_user_settings"("user_id", "namespace");

-- CreateIndex
CREATE UNIQUE INDEX "blocked_users_tenant_id_blocker_id_blocked_id_key" ON "blocked_users"("tenant_id", "blocker_id", "blocked_id");

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_geo_index" ADD CONSTRAINT "post_geo_index_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_location" ADD CONSTRAINT "entity_location_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_enrollments" ADD CONSTRAINT "mfa_enrollments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent" ADD CONSTRAINT "consent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_primary_entity_id_fkey" FOREIGN KEY ("primary_entity_id") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_moderation_jobs" ADD CONSTRAINT "media_moderation_jobs_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_sentiments" ADD CONSTRAINT "post_sentiments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_sentiments" ADD CONSTRAINT "post_sentiments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comment_media" ADD CONSTRAINT "post_comment_media_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "post_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_sentiments" ADD CONSTRAINT "comment_sentiments_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "post_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_subjects" ADD CONSTRAINT "post_subjects_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_subjects" ADD CONSTRAINT "post_subjects_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_used_by_fkey" FOREIGN KEY ("used_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxonomy_categories" ADD CONSTRAINT "taxonomy_categories_dimension_id_fkey" FOREIGN KEY ("dimension_id") REFERENCES "taxonomy_dimensions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxonomy_taxons" ADD CONSTRAINT "taxonomy_taxons_parent_taxon_id_fkey" FOREIGN KEY ("parent_taxon_id") REFERENCES "taxonomy_taxons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxonomy_taxons" ADD CONSTRAINT "taxonomy_taxons_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "taxonomy_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_taxonomy_tags" ADD CONSTRAINT "post_taxonomy_tags_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_taxonomy_tags" ADD CONSTRAINT "post_taxonomy_tags_taxon_id_fkey" FOREIGN KEY ("taxon_id") REFERENCES "taxonomy_taxons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_taxonomy_tags" ADD CONSTRAINT "entity_taxonomy_tags_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_taxonomy_tags" ADD CONSTRAINT "entity_taxonomy_tags_taxon_id_fkey" FOREIGN KEY ("taxon_id") REFERENCES "taxonomy_taxons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_taxonomy_tags" ADD CONSTRAINT "product_taxonomy_tags_taxon_id_fkey" FOREIGN KEY ("taxon_id") REFERENCES "taxonomy_taxons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_taxonomy_tags" ADD CONSTRAINT "product_taxonomy_tags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_ownerships" ADD CONSTRAINT "entity_ownerships_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_ownerships" ADD CONSTRAINT "entity_ownerships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_ownerships" ADD CONSTRAINT "entity_ownerships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_ownerships" ADD CONSTRAINT "entity_ownerships_added_by_user_id_fkey" FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circle_configs" ADD CONSTRAINT "circle_configs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circle_read_states" ADD CONSTRAINT "circle_read_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_audiences" ADD CONSTRAINT "custom_audiences_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_audience_members" ADD CONSTRAINT "custom_audience_members_audience_id_fkey" FOREIGN KEY ("audience_id") REFERENCES "custom_audiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_audience_members" ADD CONSTRAINT "custom_audience_members_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "post_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_domain_fkey" FOREIGN KEY ("domain") REFERENCES "domain_reputations"("domain") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interaction_events" ADD CONSTRAINT "interaction_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parental_links" ADD CONSTRAINT "parental_links_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parental_links" ADD CONSTRAINT "parental_links_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_codes" ADD CONSTRAINT "connection_codes_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_codes" ADD CONSTRAINT "connection_codes_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_codes" ADD CONSTRAINT "connection_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_code_redemptions" ADD CONSTRAINT "connection_code_redemptions_code_id_fkey" FOREIGN KEY ("code_id") REFERENCES "connection_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_code_redemptions" ADD CONSTRAINT "connection_code_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_code_redemptions" ADD CONSTRAINT "connection_code_redemptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_personal_owner_user_id_fkey" FOREIGN KEY ("personal_owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_identity_providers" ADD CONSTRAINT "tenant_identity_providers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_role_mappings" ADD CONSTRAINT "tenant_role_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_categories" ADD CONSTRAINT "platform_categories_parent_category_id_fkey" FOREIGN KEY ("parent_category_id") REFERENCES "platform_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_classifications" ADD CONSTRAINT "tenant_classifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_classifications" ADD CONSTRAINT "tenant_classifications_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "platform_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_classification_tags" ADD CONSTRAINT "tenant_classification_tags_classification_id_fkey" FOREIGN KEY ("classification_id") REFERENCES "tenant_classifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_classification_tags" ADD CONSTRAINT "tenant_classification_tags_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "platform_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_directory_profiles" ADD CONSTRAINT "tenant_directory_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encrypted_user_settings" ADD CONSTRAINT "encrypted_user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_users" ADD CONSTRAINT "blocked_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_users" ADD CONSTRAINT "blocked_users_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_users" ADD CONSTRAINT "blocked_users_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written SQL (not expressible in schema.prisma). Every block below must
-- be preserved if this migration is ever regenerated.
-- ============================================================================

-- Consent: active-row uniqueness for CROSS_REGION rows. The Prisma
-- @@unique([userId, purpose, studyId]) does not constrain CROSS_REGION rows
-- (studyId IS NULL there; Postgres treats NULLs as distinct) — this partial
-- unique index guarantees a single ACTIVE cross-region row per
-- (user, dataRegion, accessRegion). See the Consent model doc comment.
CREATE UNIQUE INDEX "consent_cross_region_key"
  ON "consent" ("user_id", "data_region", "access_region")
  WHERE "purpose" = 'CROSS_REGION' AND "active";

-- FeatureToggle: global-row uniqueness. @@unique([key, tenantId]) alone would
-- permit duplicate global rows (tenant_id IS NULL is distinct in Postgres).
CREATE UNIQUE INDEX "feature_toggles_key_global"
  ON "feature_toggles" ("key")
  WHERE "tenant_id" IS NULL;

-- Spatial index for ST_DWithin / KNN (<->) proximity queries over
-- entity_location.location (C7).
CREATE INDEX "entity_location_location_idx" ON "entity_location" USING GIST ("location");

-- Trigram GIN indexes for similarity() / % matching on directory search fields.
CREATE INDEX "tenant_display_name_trgm_idx" ON "tenants" USING GIN ("display_name" gin_trgm_ops);
CREATE INDEX "tenant_directory_profile_desc_trgm_idx" ON "tenant_directory_profiles" USING GIN ("short_description" gin_trgm_ops);

-- PostGIS expression index for directory proximity search: matches the
-- ST_MakePoint(lng, lat)::geography value ST_DWithin filters on
-- (TenantDirectoryProfile stores lat/lng as plain columns by design).
CREATE INDEX "tenant_directory_profile_location_idx" ON "tenant_directory_profiles" USING GIST ((ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)::geography));
