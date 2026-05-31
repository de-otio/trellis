/**
 * Migration Script: Initialize ActivityPub Fields for Existing Users
 *
 * ⚠️ NOTE: This script is only needed if you have existing users in the database.
 * For fresh databases with no users, simply use the reset script:
 *   bash scripts/reset-database.sh
 *
 * This script migrates existing users to have ActivityPub actor fields:
 * - Generates actor URIs for users without them
 * - Generates RSA key pairs for users without them
 * - Encrypts private keys for storage
 * - Updates collection URLs (inbox, outbox, followers, following, friends)
 *
 * Usage:
 *   npx tsx scripts/migrate-users-activitypub.ts [--dry-run] [--region=EU|US|CN]
 *
 * Options:
 *   --dry-run: Show what would be migrated without making changes
 *   --region: Process users from specific region (default: all regions)
 *   --limit: Limit number of users to process (for testing)
 */

import { PrismaClient } from "@prisma/client";
import { KeyPairService } from "../src/lib/activitypub/crypto";
import { UserActorDispatcher } from "../src/lib/activitypub/dispatchers/user-actor";
import { getActivityPubBaseUrl } from "../src/lib/activitypub/fedify/context";
import type { Env } from "../src/env";

// Mock environment for migration script
const mockEnv: Env = {
  DATABASE_URL: process.env.DATABASE_URL || "",
  DIRECT_URL: process.env.DIRECT_URL || process.env.DATABASE_URL || "",
  SESSION_SECRET: process.env.SESSION_SECRET || "migration-script-secret",
  APP_DOMAIN: process.env.APP_DOMAIN || "https://example.com",
  ACTIVITYPUB_BASE_URL:
    process.env.ACTIVITYPUB_BASE_URL ||
    process.env.APP_DOMAIN ||
    "https://example.com",
  SUPABASE_URL: process.env.SUPABASE_URL || "",
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY || "",
} as Env;

interface MigrationStats {
  total: number;
  migrated: number;
  skipped: number;
  errors: number;
  details: {
    actorUriGenerated: number;
    keyPairGenerated: number;
    collectionUrlsUpdated: number;
  };
}

/**
 * Migrate a single user to ActivityPub
 */
async function migrateUser(
  prisma: PrismaClient,
  user: {
    id: string;
    username: string | null;
    email: string;
    actorId: string | null;
    publicKey: string | null;
    privateKey: string | null;
  },
  dryRun: boolean,
  stats: MigrationStats,
): Promise<void> {
  try {
    // Skip if user doesn't have username (required for actor URI)
    if (!user.username) {
      console.log(`  ⏭️  Skipping user ${user.email}: no username`);
      stats.skipped++;
      return;
    }

    const baseUrl = getActivityPubBaseUrl(mockEnv);
    const actorUri = UserActorDispatcher.generateActorUri(
      user.username,
      mockEnv,
    );
    const collectionUrls = {
      inbox: `${actorUri}/inbox`,
      outbox: `${actorUri}/outbox`,
      followers: `${actorUri}/followers`,
      following: `${actorUri}/following`,
      friends: `${actorUri}/friends`,
    };

    const updates: {
      actorId?: string;
      inboxUrl?: string;
      outboxUrl?: string;
      followersUrl?: string;
      followingUrl?: string;
      friendsUrl?: string;
      publicKey?: string;
      privateKey?: string;
    } = {};

    // Generate actor URI if missing
    if (!user.actorId) {
      updates.actorId = actorUri;
      updates.inboxUrl = collectionUrls.inbox;
      updates.outboxUrl = collectionUrls.outbox;
      updates.followersUrl = collectionUrls.followers;
      updates.followingUrl = collectionUrls.following;
      updates.friendsUrl = collectionUrls.friends;
      stats.details.actorUriGenerated++;
      console.log(`  ✅ Generated actor URI: ${actorUri}`);
    } else {
      // Update collection URLs if actor URI exists but URLs are missing
      if (!user.actorId.includes("/inbox")) {
        // Check if collection URLs need updating
        const needsUpdate =
          !user.actorId.endsWith("/inbox") && !user.actorId.endsWith("/outbox");
        if (needsUpdate) {
          updates.inboxUrl = collectionUrls.inbox;
          updates.outboxUrl = collectionUrls.outbox;
          updates.followersUrl = collectionUrls.followers;
          updates.followingUrl = collectionUrls.following;
          updates.friendsUrl = collectionUrls.friends;
          stats.details.collectionUrlsUpdated++;
        }
      }
    }

    // Generate key pair if missing
    if (!user.publicKey || !user.privateKey) {
      const { publicKey, privateKey } = KeyPairService.generateKeyPair();
      updates.publicKey = publicKey;

      // Encrypt private key for storage
      try {
        updates.privateKey = KeyPairService.encryptPrivateKey(
          privateKey,
          mockEnv,
        );
      } catch (encryptError: any) {
        console.error(
          `  ❌ Failed to encrypt private key for ${user.email}:`,
          encryptError.message,
        );
        // Store unencrypted as fallback (should be encrypted in production)
        updates.privateKey = privateKey;
      }

      stats.details.keyPairGenerated++;
      console.log(`  ✅ Generated key pair for ${user.email}`);
    }

    // Apply updates if not dry run
    if (!dryRun && Object.keys(updates).length > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: updates,
      });
      stats.migrated++;
      console.log(`  ✅ Migrated user ${user.email}`);
    } else if (dryRun) {
      console.log(`  🔍 [DRY RUN] Would update user ${user.email}:`, updates);
      stats.migrated++;
    }
  } catch (error: any) {
    console.error(`  ❌ Error migrating user ${user.email}:`, error.message);
    stats.errors++;
  }
}

/**
 * Main migration function
 */
async function migrateUsersActivityPub() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const regionArg = args.find((arg) => arg.startsWith("--region="));
  const region = regionArg ? regionArg.split("=")[1] : undefined;
  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : undefined;

  if (dryRun) {
    console.log("🔍 DRY RUN MODE - No changes will be made\n");
  }

  console.log("🚀 Starting ActivityPub user migration...\n");

  // Validate database URL
  if (!mockEnv.DATABASE_URL) {
    console.error("❌ DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: mockEnv.DATABASE_URL,
      },
    },
  });

  const stats: MigrationStats = {
    total: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
    details: {
      actorUriGenerated: 0,
      keyPairGenerated: 0,
      collectionUrlsUpdated: 0,
    },
  };

  try {
    // Find users that need migration
    // Users without actorId or without key pairs
    const whereClause: any = {
      OR: [{ actorId: null }, { publicKey: null }, { privateKey: null }],
      username: { not: null }, // Only users with usernames
    };

    if (region) {
      whereClause.region = region;
    }

    const users = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        username: true,
        email: true,
        actorId: true,
        publicKey: true,
        privateKey: true,
      },
      take: limit,
    });

    stats.total = users.length;

    console.log(
      `📊 Found ${users.length} users to migrate${region ? ` (region: ${region})` : ""}\n`,
    );

    if (users.length === 0) {
      console.log("✅ No users need migration");
      return;
    }

    // Process users in batches
    const batchSize = 10;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      console.log(
        `\n📦 Processing batch ${Math.floor(i / batchSize) + 1} (${batch.length} users)...`,
      );

      await Promise.all(
        batch.map((user) => migrateUser(prisma, user, dryRun, stats)),
      );
    }

    // Print summary
    console.log("\n" + "=".repeat(60));
    console.log("📊 Migration Summary");
    console.log("=".repeat(60));
    console.log(`Total users processed: ${stats.total}`);
    console.log(`✅ Migrated: ${stats.migrated}`);
    console.log(`⏭️  Skipped: ${stats.skipped}`);
    console.log(`❌ Errors: ${stats.errors}`);
    console.log("\nDetails:");
    console.log(`  - Actor URIs generated: ${stats.details.actorUriGenerated}`);
    console.log(`  - Key pairs generated: ${stats.details.keyPairGenerated}`);
    console.log(
      `  - Collection URLs updated: ${stats.details.collectionUrlsUpdated}`,
    );
    console.log("=".repeat(60));

    if (dryRun) {
      console.log("\n⚠️  This was a DRY RUN - no changes were made");
      console.log("   Run without --dry-run to apply changes");
    }
  } catch (error: any) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run migration
migrateUsersActivityPub().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
