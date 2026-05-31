/**
 * Seed Role Metadata
 *
 * This script creates role metadata entries for all UserRole enum values.
 * Role metadata is used for UI display and documentation purposes.
 *
 * Roles are defined in prisma/schema.prisma as UserRole enum:
 * - END_USER
 * - B2B_PARTNER
 * - PARTNER_ADMIN
 * - INTERNAL
 * - CONTENT_CREATOR
 * - SUPER_ADMIN
 *
 * IMPORTANT: This script uses raw SQL with direct connection to avoid
 * Prisma prepared statement connection pooling issues.
 * Uses PostgreSQL INSERT ... ON CONFLICT (upsert) for idempotency.
 *
 * Run with: npx tsx apps/api/scripts/seed-roles.ts
 *
 * Environment variable: ENVIRONMENT or DEPLOY_ENV (defaults to 'dev')
 */

import { Client } from "pg";
import { UserRole } from "@prisma/client";

// Helper to get database URL from environment or AWS SSM
async function getDatabaseUrl(): Promise<string> {
  // First try environment variables
  if (process.env.DIRECT_DATABASE_URL) {
    return process.env.DIRECT_DATABASE_URL;
  }
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // Try to fetch from AWS SSM Parameter Store
  try {
    const { getSsmParameter } = await import("../test/utils/aws-ssm");
    const env = process.env.ENVIRONMENT || process.env.DEPLOY_ENV || "dev";

    // Try DIRECT_DATABASE_URL first
    const directUrl = await getSsmParameter("DIRECT_DATABASE_URL", {
      environment: env,
      required: false,
    });
    if (directUrl) {
      return directUrl;
    }

    // Fall back to DATABASE_URL
    const dbUrl = await getSsmParameter("DATABASE_URL", {
      environment: env,
      required: false,
    });
    if (dbUrl) {
      return dbUrl;
    }
  } catch (error) {
    console.warn(
      "⚠️  Could not fetch from AWS SSM:",
      error instanceof Error ? error.message : String(error),
    );
  }

  throw new Error(
    "DIRECT_DATABASE_URL or DATABASE_URL must be set in environment variables " +
      "or available in AWS SSM Parameter Store. " +
      'Set DIRECT_DATABASE_URL="postgresql://..." or configure AWS credentials.',
  );
}

interface RoleMetadataSeed {
  role: UserRole;
  displayName: string;
  description: string;
  category: "end_user" | "partner" | "internal" | "system";
  permissions?: Record<string, any>;
}

/**
 * Define role metadata for all roles
 */
function getRoleMetadata(): RoleMetadataSeed[] {
  return [
    {
      role: "END_USER",
      displayName: "End User",
      description:
        "Standard user with basic access to create posts, follow users, and interact with content.",
      category: "end_user",
      permissions: {
        canCreatePosts: true,
        canFollowUsers: true,
        canComment: true,
        canLike: true,
      },
    },
    {
      role: "B2B_PARTNER",
      displayName: "B2B Partner",
      description:
        "Business partner with access to partner-specific features and analytics.",
      category: "partner",
      permissions: {
        canCreatePosts: true,
        canAccessPartnerDashboard: true,
        canViewAnalytics: true,
      },
    },
    {
      role: "PARTNER_ADMIN",
      displayName: "Partner Administrator",
      description:
        "Administrator for a business partner with full access to partner management features.",
      category: "partner",
      permissions: {
        canCreatePosts: true,
        canAccessPartnerDashboard: true,
        canManagePartnerUsers: true,
        canViewAnalytics: true,
        canManagePartnerSettings: true,
      },
    },
    {
      role: "INTERNAL",
      displayName: "Internal Staff",
      description:
        "Internal team member with access to internal tools and administrative features.",
      category: "internal",
      permissions: {
        canCreatePosts: true,
        canAccessInternalDashboard: true,
        canViewAnalytics: true,
        canManageContent: true,
      },
    },
    {
      role: "CONTENT_CREATOR",
      displayName: "Content Creator",
      description:
        "Content creator with enhanced posting capabilities and content management features.",
      category: "system",
      permissions: {
        canCreatePosts: true,
        canCreateAdvancedContent: true,
        canSchedulePosts: true,
        canViewContentAnalytics: true,
      },
    },
    {
      role: "SUPER_ADMIN",
      displayName: "Super Administrator",
      description:
        "System administrator with full access to all features and administrative capabilities.",
      category: "system",
      permissions: {
        canCreatePosts: true,
        canAccessAdminDashboard: true,
        canManageUsers: true,
        canManageSystemSettings: true,
        canViewAllAnalytics: true,
        canManageRoles: true,
      },
    },
  ];
}

async function seedRoles() {
  const env = process.env.ENVIRONMENT || process.env.DEPLOY_ENV || "dev";
  console.log(`🌱 Seeding role metadata for environment: ${env}`);

  const client = new Client({
    connectionString: await getDatabaseUrl(),
  });

  try {
    await client.connect();
    console.log("✅ Connected to database");

    const roleMetadata = getRoleMetadata();
    console.log(`📋 Seeding ${roleMetadata.length} role metadata entries...`);

    let created = 0;
    let updated = 0;

    // Use raw SQL with INSERT ... ON CONFLICT (upsert) to avoid prepared statement issues
    // This uses parameterized queries to prevent SQL injection
    // Table name is "role_metadata" (snake_case) as defined in Prisma schema @@map("role_metadata")
    // Column names are also snake_case as defined in @map() directives
    const upsertQuery = `
      INSERT INTO role_metadata (
        role,
        display_name,
        description,
        category,
        permissions,
        is_active,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), NOW())
      ON CONFLICT (role)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        permissions = EXCLUDED.permissions,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
      RETURNING 
        role,
        created_at,
        updated_at,
        (xmax = 0) AS was_inserted
    `;

    for (const roleData of roleMetadata) {
      try {
        const permissionsJson = roleData.permissions
          ? JSON.stringify(roleData.permissions)
          : null;

        const result = await client.query(upsertQuery, [
          roleData.role,
          roleData.displayName,
          roleData.description,
          roleData.category,
          permissionsJson,
          true, // isActive
        ]);

        if (result.rows.length > 0) {
          const row = result.rows[0];
          // was_inserted is true if it was a new row (xmax = 0 means no update occurred)
          const wasInserted = row.was_inserted === true;

          if (wasInserted) {
            created++;
            console.log(
              `  ✅ Created: ${roleData.role} (${roleData.displayName})`,
            );
          } else {
            updated++;
            console.log(
              `  ✅ Updated: ${roleData.role} (${roleData.displayName})`,
            );
          }
        }
      } catch (error) {
        console.error(
          `  ❌ Error seeding role ${roleData.role}:`,
          error instanceof Error ? error.message : String(error),
        );
        // Don't throw - continue with other roles
        // This allows partial seeding if one role fails
      }
    }

    console.log("");
    console.log(`✅ Role metadata seeding complete!`);
    console.log(`   Created: ${created}`);
    console.log(`   Updated: ${updated}`);
    console.log(`   Total: ${roleMetadata.length}`);

    // Verify seeding
    const countResult = await client.query(
      "SELECT COUNT(*) as count FROM role_metadata WHERE is_active = true",
    );
    const count = parseInt(countResult.rows[0].count, 10);
    console.log(`   Active roles in database: ${count}`);

    if (count < roleMetadata.length) {
      console.warn(
        `⚠️  Warning: Expected ${roleMetadata.length} active roles, found ${count}`,
      );
    }
  } catch (error) {
    console.error("❌ Error seeding role metadata:", error);
    process.exit(1);
  } finally {
    await client.end();
    console.log("✅ Database connection closed");
  }
}

// Run if called directly (ES module compatible)
if (import.meta.url === `file://${process.argv[1]}`) {
  seedRoles().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

export { getRoleMetadata, seedRoles };
