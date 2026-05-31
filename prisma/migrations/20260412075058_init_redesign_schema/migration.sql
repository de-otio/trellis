-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'MEMORIAL', 'TRANSFERRED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('END_USER', 'B2B_PARTNER', 'PARTNER_ADMIN', 'INTERNAL', 'CONTENT_CREATOR', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "PostRadius" AS ENUM ('WHISPER', 'NORMAL', 'LOUD', 'SHOUT');

-- CreateEnum
CREATE TYPE "Privacy" AS ENUM ('PUBLIC', 'FOLLOWERS', 'PRIVATE');

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

-- CreateTable
CREATE TABLE "entities" (
    "id" TEXT NOT NULL,
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
    "entity_ref" TEXT,
    "geohash" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "place" TEXT,
    "labels" JSONB DEFAULT '[]',
    "sensitivity_level" TEXT NOT NULL DEFAULT 'benign',

    CONSTRAINT "post_geo_index_pkey" PRIMARY KEY ("post_uri")
);

-- CreateTable
CREATE TABLE "ingest_state" (
    "id" TEXT NOT NULL,
    "cursor" TEXT,
    "last_processed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingest_state_pkey" PRIMARY KEY ("id")
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
    "handle" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cognito_sub" TEXT,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "suspended_at" TIMESTAMP(3),
    "suspended_reason" TEXT,
    "partnerId" TEXT,
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
    "encryption_key_id" TEXT,
    "default_context" TEXT NOT NULL DEFAULT 'primary',
    "travel_mode_active" BOOLEAN NOT NULL DEFAULT false,
    "travel_mode_activated_at" TIMESTAMP(3),
    "panic_action_config" TEXT,
    "email_hash" TEXT,
    "anonymous_id" TEXT,
    "message_retention_days" INTEGER,
    "auto_delete_after_days" INTEGER,
    "date_of_birth" TIMESTAMP(3),
    "age_tier" "AgeTier" NOT NULL DEFAULT 'ADULT',
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
CREATE TABLE "user_encryption_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "context_id" TEXT NOT NULL,
    "encrypted_key" TEXT NOT NULL,
    "kdf_params" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'AES-256-GCM',
    "keyPurpose" TEXT NOT NULL,
    "key_type" TEXT NOT NULL DEFAULT 'border_safety',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMP(3),

    CONSTRAINT "user_encryption_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cross_region_consent" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "data_region" TEXT NOT NULL,
    "access_region" TEXT NOT NULL,
    "consented" BOOLEAN NOT NULL DEFAULT false,
    "consented_at" TIMESTAMP(3),
    "withdrawn_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cross_region_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
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
    "sensitivity_level" TEXT NOT NULL DEFAULT 'benign',
    "owner_context" TEXT NOT NULL DEFAULT 'primary',
    "screening_risk_level" TEXT NOT NULL DEFAULT 'low',
    "content_category" TEXT,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_files" (
    "id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "cid" TEXT,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "original_key" TEXT NOT NULL,
    "thumbnail_key" TEXT,
    "optimized_key" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "duration" INTEGER,
    "exif_data" JSONB,
    "iptc_data" JSONB,
    "video_metadata" JSONB,
    "date_taken" TIMESTAMP(3),
    "gps_latitude" DOUBLE PRECISION,
    "gps_longitude" DOUBLE PRECISION,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata_visible" BOOLEAN NOT NULL DEFAULT true,
    "location_visible" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "hidden_at" TIMESTAMP(3),
    "hidden_by" TEXT,
    "upload_status" TEXT NOT NULL DEFAULT 'PENDING',
    "uploaded_by" TEXT,
    "upload_batch_id" TEXT,
    "reconciled_at" TIMESTAMP(3),
    "reconcile_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_via_reconciliation" BOOLEAN NOT NULL DEFAULT false,
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
CREATE TABLE "post_media" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "alt" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "post_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_sentiments" (
    "id" TEXT NOT NULL,
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
    "sensitivity_level" TEXT NOT NULL DEFAULT 'benign',
    "owner_context" TEXT NOT NULL DEFAULT 'primary',
    "screening_risk_level" TEXT NOT NULL DEFAULT 'low',
    "content_category" TEXT,

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
    "partnerId" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "details" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retention_until" TIMESTAMP(3),

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_toggles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
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
    "product_id" TEXT NOT NULL,
    "taxon_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_taxonomy_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_ownerships" (
    "id" TEXT NOT NULL,
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
    "encrypted_text" TEXT,
    "encryption_key_id" TEXT,
    "encryption_algorithm" TEXT DEFAULT 'AES-256-GCM',
    "encryption_iv" TEXT,
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
CREATE TABLE "link_reports" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "link_url" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_reports_pkey" PRIMARY KEY ("id")
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_code_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "entities_actor_uri_key" ON "entities"("actor_uri");

-- CreateIndex
CREATE INDEX "entities_status_idx" ON "entities"("status");

-- CreateIndex
CREATE INDEX "entities_entity_type_status_idx" ON "entities"("entity_type", "status");

-- CreateIndex
CREATE INDEX "post_geo_index_entity_ref_idx" ON "post_geo_index"("entity_ref");

-- CreateIndex
CREATE INDEX "post_geo_index_geohash_idx" ON "post_geo_index"("geohash");

-- CreateIndex
CREATE INDEX "post_geo_index_sensitivity_level_idx" ON "post_geo_index"("sensitivity_level");

-- CreateIndex
CREATE UNIQUE INDEX "ingest_state_cursor_key" ON "ingest_state"("cursor");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_actor_uri_key" ON "users"("actor_uri");

-- CreateIndex
CREATE UNIQUE INDEX "users_cognito_sub_key" ON "users"("cognito_sub");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_hash_key" ON "users"("email_hash");

-- CreateIndex
CREATE UNIQUE INDEX "users_anonymous_id_key" ON "users"("anonymous_id");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_region_idx" ON "users"("region");

-- CreateIndex
CREATE INDEX "users_data_region_idx" ON "users"("data_region");

-- CreateIndex
CREATE INDEX "users_suspended_idx" ON "users"("suspended");

-- CreateIndex
CREATE INDEX "users_partnerId_idx" ON "users"("partnerId");

-- CreateIndex
CREATE INDEX "users_username_idx" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_email_verified_idx" ON "users"("email_verified");

-- CreateIndex
CREATE INDEX "users_identity_verified_idx" ON "users"("identity_verified");

-- CreateIndex
CREATE INDEX "users_actor_uri_idx" ON "users"("actor_uri");

-- CreateIndex
CREATE INDEX "users_encryption_key_id_idx" ON "users"("encryption_key_id");

-- CreateIndex
CREATE INDEX "users_travel_mode_active_idx" ON "users"("travel_mode_active");

-- CreateIndex
CREATE INDEX "users_default_context_idx" ON "users"("default_context");

-- CreateIndex
CREATE INDEX "users_email_hash_idx" ON "users"("email_hash");

-- CreateIndex
CREATE INDEX "users_anonymous_id_idx" ON "users"("anonymous_id");

-- CreateIndex
CREATE INDEX "users_cognito_sub_idx" ON "users"("cognito_sub");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_enrollments_user_id_key" ON "mfa_enrollments"("user_id");

-- CreateIndex
CREATE INDEX "user_encryption_keys_user_id_idx" ON "user_encryption_keys"("user_id");

-- CreateIndex
CREATE INDEX "user_encryption_keys_user_id_key_type_idx" ON "user_encryption_keys"("user_id", "key_type");

-- CreateIndex
CREATE UNIQUE INDEX "user_encryption_keys_user_id_context_id_keyPurpose_key_type_key" ON "user_encryption_keys"("user_id", "context_id", "keyPurpose", "key_type");

-- CreateIndex
CREATE INDEX "cross_region_consent_user_id_idx" ON "cross_region_consent"("user_id");

-- CreateIndex
CREATE INDEX "cross_region_consent_consented_idx" ON "cross_region_consent"("consented");

-- CreateIndex
CREATE INDEX "cross_region_consent_data_region_access_region_idx" ON "cross_region_consent"("data_region", "access_region");

-- CreateIndex
CREATE UNIQUE INDEX "cross_region_consent_user_id_data_region_access_region_key" ON "cross_region_consent"("user_id", "data_region", "access_region");

-- CreateIndex
CREATE UNIQUE INDEX "posts_activity_id_key" ON "posts"("activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "posts_object_id_key" ON "posts"("object_id");

-- CreateIndex
CREATE INDEX "posts_author_id_created_at_idx" ON "posts"("author_id", "created_at");

-- CreateIndex
CREATE INDEX "posts_author_id_radius_created_at_idx" ON "posts"("author_id", "radius", "created_at");

-- CreateIndex
CREATE INDEX "posts_primary_entity_id_idx" ON "posts"("primary_entity_id");

-- CreateIndex
CREATE INDEX "posts_created_at_idx" ON "posts"("created_at");

-- CreateIndex
CREATE INDEX "posts_uri_idx" ON "posts"("uri");

-- CreateIndex
CREATE INDEX "posts_deleted_at_idx" ON "posts"("deleted_at");

-- CreateIndex
CREATE INDEX "posts_data_region_created_at_idx" ON "posts"("data_region", "created_at");

-- CreateIndex
CREATE INDEX "posts_activity_id_idx" ON "posts"("activity_id");

-- CreateIndex
CREATE INDEX "posts_object_id_idx" ON "posts"("object_id");

-- CreateIndex
CREATE INDEX "posts_group_id_idx" ON "posts"("group_id");

-- CreateIndex
CREATE INDEX "posts_author_id_owner_context_sensitivity_level_idx" ON "posts"("author_id", "owner_context", "sensitivity_level");

-- CreateIndex
CREATE INDEX "posts_sensitivity_level_idx" ON "posts"("sensitivity_level");

-- CreateIndex
CREATE INDEX "posts_owner_context_idx" ON "posts"("owner_context");

-- CreateIndex
CREATE INDEX "posts_screening_risk_level_idx" ON "posts"("screening_risk_level");

-- CreateIndex
CREATE INDEX "posts_edited_at_idx" ON "posts"("edited_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_files_content_hash_key" ON "media_files"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "media_files_cid_key" ON "media_files"("cid");

-- CreateIndex
CREATE INDEX "media_files_content_hash_idx" ON "media_files"("content_hash");

-- CreateIndex
CREATE INDEX "media_files_cid_idx" ON "media_files"("cid");

-- CreateIndex
CREATE INDEX "media_files_hidden_deleted_at_idx" ON "media_files"("hidden", "deleted_at");

-- CreateIndex
CREATE INDEX "media_files_created_at_idx" ON "media_files"("created_at");

-- CreateIndex
CREATE INDEX "media_files_date_taken_idx" ON "media_files"("date_taken");

-- CreateIndex
CREATE INDEX "media_files_metadata_visible_idx" ON "media_files"("metadata_visible");

-- CreateIndex
CREATE INDEX "media_files_location_visible_idx" ON "media_files"("location_visible");

-- CreateIndex
CREATE INDEX "media_files_gps_latitude_gps_longitude_idx" ON "media_files"("gps_latitude", "gps_longitude");

-- CreateIndex
CREATE INDEX "media_files_upload_status_idx" ON "media_files"("upload_status");

-- CreateIndex
CREATE INDEX "media_files_uploaded_by_idx" ON "media_files"("uploaded_by");

-- CreateIndex
CREATE INDEX "media_files_upload_batch_id_idx" ON "media_files"("upload_batch_id");

-- CreateIndex
CREATE INDEX "media_files_reconciled_at_idx" ON "media_files"("reconciled_at");

-- CreateIndex
CREATE INDEX "media_files_upload_status_reconciled_at_idx" ON "media_files"("upload_status", "reconciled_at");

-- CreateIndex
CREATE INDEX "media_files_attached_to_post_created_at_idx" ON "media_files"("attached_to_post", "created_at");

-- CreateIndex
CREATE INDEX "media_files_orphaned_at_idx" ON "media_files"("orphaned_at");

-- CreateIndex
CREATE INDEX "upload_sessions_user_id_status_idx" ON "upload_sessions"("user_id", "status");

-- CreateIndex
CREATE INDEX "upload_sessions_expires_at_idx" ON "upload_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "post_media_post_id_idx" ON "post_media"("post_id");

-- CreateIndex
CREATE INDEX "post_media_media_id_idx" ON "post_media"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_media_post_id_media_id_key" ON "post_media"("post_id", "media_id");

-- CreateIndex
CREATE INDEX "post_sentiments_post_id_idx" ON "post_sentiments"("post_id");

-- CreateIndex
CREATE INDEX "post_sentiments_post_uri_idx" ON "post_sentiments"("post_uri");

-- CreateIndex
CREATE INDEX "post_sentiments_author_id_idx" ON "post_sentiments"("author_id");

-- CreateIndex
CREATE INDEX "post_sentiments_post_id_sentiment_idx" ON "post_sentiments"("post_id", "sentiment");

-- CreateIndex
CREATE INDEX "post_sentiments_post_id_created_at_idx" ON "post_sentiments"("post_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_post_sentiment_summary" ON "post_sentiments"("post_id", "sentiment", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_post_sentiment_pagination" ON "post_sentiments"("post_id", "sentiment", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "post_sentiments_post_id_author_id_key" ON "post_sentiments"("post_id", "author_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_sentiments_post_uri_author_id_key" ON "post_sentiments"("post_uri", "author_id");

-- CreateIndex
CREATE INDEX "post_comments_post_id_created_at_idx" ON "post_comments"("post_id", "created_at");

-- CreateIndex
CREATE INDEX "post_comments_post_uri_created_at_idx" ON "post_comments"("post_uri", "created_at");

-- CreateIndex
CREATE INDEX "post_comments_author_id_idx" ON "post_comments"("author_id");

-- CreateIndex
CREATE INDEX "post_comments_hidden_by_post_owner_idx" ON "post_comments"("hidden_by_post_owner");

-- CreateIndex
CREATE INDEX "post_comments_deleted_at_idx" ON "post_comments"("deleted_at");

-- CreateIndex
CREATE INDEX "post_comments_author_id_owner_context_idx" ON "post_comments"("author_id", "owner_context");

-- CreateIndex
CREATE INDEX "post_comments_sensitivity_level_idx" ON "post_comments"("sensitivity_level");

-- CreateIndex
CREATE INDEX "post_comments_owner_context_idx" ON "post_comments"("owner_context");

-- CreateIndex
CREATE INDEX "post_comments_screening_risk_level_idx" ON "post_comments"("screening_risk_level");

-- CreateIndex
CREATE INDEX "post_comments_root_uri_idx" ON "post_comments"("root_uri");

-- CreateIndex
CREATE INDEX "post_comments_reply_to_uri_idx" ON "post_comments"("reply_to_uri");

-- CreateIndex
CREATE INDEX "post_comments_root_uri_created_at_idx" ON "post_comments"("root_uri", "created_at");

-- CreateIndex
CREATE INDEX "post_comments_post_id_root_uri_idx" ON "post_comments"("post_id", "root_uri");

-- CreateIndex
CREATE INDEX "post_comment_media_comment_id_idx" ON "post_comment_media"("comment_id");

-- CreateIndex
CREATE INDEX "post_comment_media_media_id_idx" ON "post_comment_media"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_comment_media_comment_id_media_id_key" ON "post_comment_media"("comment_id", "media_id");

-- CreateIndex
CREATE INDEX "comment_sentiments_comment_id_idx" ON "comment_sentiments"("comment_id");

-- CreateIndex
CREATE INDEX "comment_sentiments_comment_uri_idx" ON "comment_sentiments"("comment_uri");

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
CREATE INDEX "post_subjects_post_id_idx" ON "post_subjects"("post_id");

-- CreateIndex
CREATE INDEX "post_subjects_entity_id_created_at_idx" ON "post_subjects"("entity_id", "created_at");

-- CreateIndex
CREATE INDEX "post_subjects_entity_id_idx" ON "post_subjects"("entity_id");

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
CREATE INDEX "security_events_partnerId_idx" ON "security_events"("partnerId");

-- CreateIndex
CREATE INDEX "security_events_ip_address_idx" ON "security_events"("ip_address");

-- CreateIndex
CREATE INDEX "security_events_retention_until_idx" ON "security_events"("retention_until");

-- CreateIndex
CREATE UNIQUE INDEX "feature_toggles_key_key" ON "feature_toggles"("key");

-- CreateIndex
CREATE INDEX "feature_toggles_key_idx" ON "feature_toggles"("key");

-- CreateIndex
CREATE INDEX "feature_toggles_enabled_idx" ON "feature_toggles"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_code_key" ON "invitations"("code");

-- CreateIndex
CREATE INDEX "invitations_code_idx" ON "invitations"("code");

-- CreateIndex
CREATE INDEX "invitations_created_by_idx" ON "invitations"("created_by");

-- CreateIndex
CREATE INDEX "invitations_created_by_created_at_idx" ON "invitations"("created_by", "created_at");

-- CreateIndex
CREATE INDEX "invitations_used_by_idx" ON "invitations"("used_by");

-- CreateIndex
CREATE INDEX "invitations_used_idx" ON "invitations"("used");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE INDEX "invitations_expires_at_idx" ON "invitations"("expires_at");

-- CreateIndex
CREATE INDEX "taxonomy_dimensions_tenant_id_idx" ON "taxonomy_dimensions"("tenant_id");

-- CreateIndex
CREATE INDEX "taxonomy_dimensions_tenant_id_code_idx" ON "taxonomy_dimensions"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "taxonomy_dimensions_tenant_id_is_active_idx" ON "taxonomy_dimensions"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomy_dimensions_tenant_id_code_key" ON "taxonomy_dimensions"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "taxonomy_categories_tenant_id_idx" ON "taxonomy_categories"("tenant_id");

-- CreateIndex
CREATE INDEX "taxonomy_categories_tenant_id_dimension_id_idx" ON "taxonomy_categories"("tenant_id", "dimension_id");

-- CreateIndex
CREATE INDEX "taxonomy_categories_tenant_id_is_active_idx" ON "taxonomy_categories"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomy_categories_tenant_id_dimension_id_code_key" ON "taxonomy_categories"("tenant_id", "dimension_id", "code");

-- CreateIndex
CREATE INDEX "taxonomy_taxons_tenant_id_idx" ON "taxonomy_taxons"("tenant_id");

-- CreateIndex
CREATE INDEX "taxonomy_taxons_tenant_id_category_id_idx" ON "taxonomy_taxons"("tenant_id", "category_id");

-- CreateIndex
CREATE INDEX "taxonomy_taxons_tenant_id_taxonId_idx" ON "taxonomy_taxons"("tenant_id", "taxonId");

-- CreateIndex
CREATE INDEX "taxonomy_taxons_tenant_id_is_active_idx" ON "taxonomy_taxons"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "taxonomy_taxons_parent_taxon_id_idx" ON "taxonomy_taxons"("parent_taxon_id");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomy_taxons_tenant_id_taxonId_key" ON "taxonomy_taxons"("tenant_id", "taxonId");

-- CreateIndex
CREATE INDEX "post_taxonomy_tags_post_id_idx" ON "post_taxonomy_tags"("post_id");

-- CreateIndex
CREATE INDEX "post_taxonomy_tags_taxon_id_idx" ON "post_taxonomy_tags"("taxon_id");

-- CreateIndex
CREATE INDEX "post_taxonomy_tags_added_by_idx" ON "post_taxonomy_tags"("added_by");

-- CreateIndex
CREATE UNIQUE INDEX "post_taxonomy_tags_post_id_taxon_id_key" ON "post_taxonomy_tags"("post_id", "taxon_id");

-- CreateIndex
CREATE INDEX "entity_taxonomy_tags_entity_id_idx" ON "entity_taxonomy_tags"("entity_id");

-- CreateIndex
CREATE INDEX "entity_taxonomy_tags_taxon_id_idx" ON "entity_taxonomy_tags"("taxon_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_taxonomy_tags_entity_id_taxon_id_key" ON "entity_taxonomy_tags"("entity_id", "taxon_id");

-- CreateIndex
CREATE INDEX "product_taxonomy_tags_product_id_idx" ON "product_taxonomy_tags"("product_id");

-- CreateIndex
CREATE INDEX "product_taxonomy_tags_taxon_id_idx" ON "product_taxonomy_tags"("taxon_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_taxonomy_tags_product_id_taxon_id_key" ON "product_taxonomy_tags"("product_id", "taxon_id");

-- CreateIndex
CREATE INDEX "entity_ownerships_entity_id_idx" ON "entity_ownerships"("entity_id");

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
CREATE INDEX "groups_actor_uri_idx" ON "groups"("actor_uri");

-- CreateIndex
CREATE INDEX "groups_privacy_idx" ON "groups"("privacy");

-- CreateIndex
CREATE INDEX "group_members_group_id_idx" ON "group_members"("group_id");

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
CREATE INDEX "direct_messages_recipient_id_idx" ON "direct_messages"("recipient_id");

-- CreateIndex
CREATE INDEX "direct_messages_recipient_id_read_idx" ON "direct_messages"("recipient_id", "read");

-- CreateIndex
CREATE INDEX "direct_messages_encryption_key_id_idx" ON "direct_messages"("encryption_key_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_audiences_collection_id_key" ON "custom_audiences"("collection_id");

-- CreateIndex
CREATE INDEX "custom_audiences_creator_id_idx" ON "custom_audiences"("creator_id");

-- CreateIndex
CREATE INDEX "custom_audience_members_audience_id_idx" ON "custom_audience_members"("audience_id");

-- CreateIndex
CREATE INDEX "custom_audience_members_member_id_idx" ON "custom_audience_members"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_audience_members_audience_id_member_id_key" ON "custom_audience_members"("audience_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "domain_reputations_domain_key" ON "domain_reputations"("domain");

-- CreateIndex
CREATE INDEX "domain_reputations_domain_idx" ON "domain_reputations"("domain");

-- CreateIndex
CREATE INDEX "domain_reputations_status_idx" ON "domain_reputations"("status");

-- CreateIndex
CREATE INDEX "domain_reputations_reputation_idx" ON "domain_reputations"("reputation");

-- CreateIndex
CREATE INDEX "link_checks_post_id_idx" ON "link_checks"("post_id");

-- CreateIndex
CREATE INDEX "link_checks_comment_id_idx" ON "link_checks"("comment_id");

-- CreateIndex
CREATE INDEX "link_checks_domain_idx" ON "link_checks"("domain");

-- CreateIndex
CREATE INDEX "link_checks_status_idx" ON "link_checks"("status");

-- CreateIndex
CREATE INDEX "link_reports_domain_idx" ON "link_reports"("domain");

-- CreateIndex
CREATE INDEX "link_reports_status_idx" ON "link_reports"("status");

-- CreateIndex
CREATE INDEX "link_reports_user_id_idx" ON "link_reports"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");

-- CreateIndex
CREATE INDEX "EmailSuppression_email_idx" ON "EmailSuppression"("email");

-- CreateIndex
CREATE INDEX "deletion_audit_logs_user_id_idx" ON "deletion_audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "parental_links_guardian_id_idx" ON "parental_links"("guardian_id");

-- CreateIndex
CREATE UNIQUE INDEX "parental_links_child_id_guardian_id_key" ON "parental_links"("child_id", "guardian_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_created_at_idx" ON "notifications"("user_id", "read", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_batch_id_idx" ON "notifications"("user_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_key" ON "notification_preferences"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "connection_codes_code_key" ON "connection_codes"("code");

-- CreateIndex
CREATE INDEX "connection_codes_creator_id_expires_at_idx" ON "connection_codes"("creator_id", "expires_at");

-- CreateIndex
CREATE INDEX "connection_codes_entity_id_idx" ON "connection_codes"("entity_id");

-- CreateIndex
CREATE INDEX "connection_code_redemptions_user_id_idx" ON "connection_code_redemptions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "connection_code_redemptions_code_id_user_id_key" ON "connection_code_redemptions"("code_id", "user_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_enrollments" ADD CONSTRAINT "mfa_enrollments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_encryption_keys" ADD CONSTRAINT "user_encryption_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cross_region_consent" ADD CONSTRAINT "cross_region_consent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_primary_entity_id_fkey" FOREIGN KEY ("primary_entity_id") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_sentiments" ADD CONSTRAINT "post_sentiments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "entity_ownerships" ADD CONSTRAINT "entity_ownerships_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_ownerships" ADD CONSTRAINT "entity_ownerships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_ownerships" ADD CONSTRAINT "entity_ownerships_added_by_user_id_fkey" FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circle_configs" ADD CONSTRAINT "circle_configs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circle_read_states" ADD CONSTRAINT "circle_read_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "link_reports" ADD CONSTRAINT "link_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parental_links" ADD CONSTRAINT "parental_links_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parental_links" ADD CONSTRAINT "parental_links_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_codes" ADD CONSTRAINT "connection_codes_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_codes" ADD CONSTRAINT "connection_codes_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_code_redemptions" ADD CONSTRAINT "connection_code_redemptions_code_id_fkey" FOREIGN KEY ("code_id") REFERENCES "connection_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_code_redemptions" ADD CONSTRAINT "connection_code_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
