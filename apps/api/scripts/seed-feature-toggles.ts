/**
 * Seed Initial Feature Toggles
 *
 * This script creates the initial feature toggles that the application expects.
 * These toggles are referenced in:
 * - apps/api/src/lib/feature-flags.ts (global feature flags)
 * - apps/api/src/lib/region-config.ts (region-specific flags)
 * - apps/api/src/lib/entity-handler.ts (entity_profiles_enabled)
 *
 * Feature flag defaults are read from environments/{ENV}/config.yaml FEATURE_FLAGS section.
 * If not specified in config, defaults to false (safe default).
 *
 * IMPORTANT: On deployment, this script OVERWRITES existing database values with config file values.
 * The config file is the source of truth - database values will be updated to match config.yaml.
 *
 * Run with: npx tsx apps/api/scripts/seed-feature-toggles.ts
 *
 * Environment variable: ENVIRONMENT or DEPLOY_ENV (defaults to 'dev')
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as yaml from "js-yaml";
import * as path from "path";

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

// Prisma client will be created after we get the database URL

interface FeatureToggleSeed {
  key: string;
  enabled: boolean;
  description: string;
}

/**
 * Load feature flag defaults from config.yaml
 * Returns a map of feature flag keys to their enabled state
 */
function loadFeatureFlagsFromConfig(): Map<string, boolean> {
  const env = process.env.ENVIRONMENT || process.env.DEPLOY_ENV || "dev";
  // Config file is in repo root, not in apps/api
  const configPath = path.join(
    process.cwd(),
    "..",
    "..",
    "environments",
    env,
    "config.yaml",
  );

  const flags = new Map<string, boolean>();

  try {
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, "utf8");
      const config = yaml.load(configContent) as any;

      if (config?.FEATURE_FLAGS && typeof config.FEATURE_FLAGS === "object") {
        console.log(`📋 Loading feature flags from ${configPath}...\n`);
        for (const [key, value] of Object.entries(config.FEATURE_FLAGS)) {
          if (typeof value === "boolean") {
            flags.set(key, value);
            console.log(`   ${key}: ${value}`);
          }
        }
        console.log("");
      } else {
        console.log(
          `⚠️  No FEATURE_FLAGS section found in ${configPath}, using defaults (false)\n`,
        );
      }
    } else {
      console.log(
        `⚠️  Config file not found: ${configPath}, using defaults (false)\n`,
      );
    }
  } catch (error) {
    console.error(
      `⚠️  Error reading config file ${configPath}:`,
      error instanceof Error ? error.message : String(error),
    );
    console.log("   Using defaults (false)\n");
  }

  return flags;
}

async function seedFeatureToggles() {
  console.log("🌱 Seeding feature toggles...\n");

  // Get database URL
  const rawUrl = await getDatabaseUrl();

  // Supabase pooler (port 6543) is not reachable from GitHub Actions runners;
  // replace with the direct connection port (5432) when present.
  const databaseUrl = rawUrl.replace(":6543/", ":5432/");

  // Create Prisma client with the direct database URL
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });

  // Store for cleanup
  prismaInstance = prisma;

  // Load feature flag defaults from config.yaml
  const configFlags = loadFeatureFlagsFromConfig();

  // Helper to get enabled state: from config if available, otherwise false (safe default)
  const getEnabled = (key: string, defaultValue: boolean = false): boolean => {
    return configFlags.has(key) ? configFlags.get(key)! : defaultValue;
  };

  // Global feature flags (from feature-flags.ts)
  // General defaults are false for safety, but can be overridden in config.yaml
  // For dev environment, enable core features by default
  const isDev =
    (
      process.env.ENVIRONMENT ||
      process.env.DEPLOY_ENV ||
      "dev"
    ).toLowerCase() === "dev";

  const globalFlags: FeatureToggleSeed[] = [
    {
      key: "posts_enabled",
      enabled: getEnabled("posts_enabled", isDev),
      description: "Enable post creation and sharing",
    },
    {
      key: "comments_enabled",
      enabled: getEnabled("comments_enabled", isDev),
      description: "Enable comments and replies on posts",
    },
    {
      key: "friends_enabled",
      enabled: getEnabled("friends_enabled", isDev),
      description: "Enable friend connections",
    },
    {
      key: "sentiments_enabled",
      enabled: getEnabled("sentiments_enabled", isDev),
      description: "Enable sentiment reactions on posts",
    },
    {
      key: "feeds_enabled",
      enabled: getEnabled("feeds_enabled", isDev),
      description: "Enable feed functionality",
    },
    {
      key: "map_enabled",
      enabled: getEnabled("map_enabled", isDev),
      description: "Enable map features",
    },
    {
      key: "entity_profiles_enabled",
      enabled: getEnabled("entity_profiles_enabled", isDev), // Enable by default in dev
      description: "Enable entity profile creation and management",
    },
    {
      key: "global_public_posting_enabled",
      enabled: getEnabled("global_public_posting_enabled", false), // Disabled by default, will be enabled later
      description: "Globally enable public posting for all users",
    },
    {
      key: "content_moderation_enabled",
      // Fail-closed-to-ENABLED by default (AR-SEC T4 / F1): text moderation is a
      // safety gate, so it must be ON unless an environment deliberately opts
      // out via config.yaml (the dev/test escape hatch). The handlers ALSO
      // fail-closed on a missing/erroring row (isEnabledFailClosed), so an
      // unseeded DB still moderates; seeding `true` makes the intended state
      // explicit and auditable.
      enabled: getEnabled("content_moderation_enabled", true), // Enabled by default (safety gate)
      description:
        "Enable automatic content moderation for posts and comments using OpenAI Moderation API",
    },
    {
      key: "email_subscriptions_enabled",
      enabled: getEnabled("email_subscriptions_enabled", false),
      description: "Anonymous email subscriptions (follow-by-email)",
    },
    {
      key: "collections_enabled",
      enabled: getEnabled("collections_enabled", false),
      description: "Curated collections / lists",
    },
    {
      key: "year_in_review_enabled",
      enabled: getEnabled("year_in_review_enabled", false),
      description: "Year-in-review recap (RecapService)",
    },
    {
      key: "events_enabled",
      // Events primitive (R1). Global default OFF (opt-in): the route set 404s
      // until an operator flips this per environment. Mirrors
      // collections_enabled — no isDev auto-enable.
      enabled: getEnabled("events_enabled", false),
      description: "Events primitive (scheduled events, RSVP, shifts)",
    },
  ];

  // Region-specific flags (from region-config.ts)
  // Format: region_<REGION>_<category>_<feature>
  const regions = ["US", "EU", "CN"];
  const regionFlags: FeatureToggleSeed[] = [];

  for (const region of regions) {
    // Authentication flags
    regionFlags.push(
      {
        key: `region_${region}_auth_email_password`,
        enabled: true,
        description: `Enable email/password authentication for ${region} region`,
      },
      {
        key: `region_${region}_auth_magic_link`,
        enabled: region !== "CN", // Magic link disabled in CN by default
        description: `Enable magic link authentication for ${region} region`,
      },
      {
        key: `region_${region}_auth_phone`,
        enabled: region === "CN", // Phone auth preferred in CN
        description: `Enable phone authentication for ${region} region`,
      },
      {
        key: `region_${region}_auth_wechat`,
        enabled: region === "CN", // WeChat popular in CN
        description: `Enable WeChat OAuth for ${region} region`,
      },
      {
        key: `region_${region}_auth_qq`,
        enabled: region === "CN", // QQ popular in CN
        description: `Enable QQ OAuth for ${region} region`,
      },
      {
        key: `region_${region}_auth_microsoft_sso`,
        enabled: region !== "CN", // Microsoft SSO blocked by GFW in CN
        description: `Enable Microsoft SSO for ${region} region`,
      },
      // Application features
      {
        key: `region_${region}_app_offline_mode`,
        enabled: region === "CN", // Offline mode useful in CN
        description: `Enable offline mode for ${region} region`,
      },
      {
        key: `region_${region}_app_realtime_updates`,
        enabled: true,
        description: `Enable real-time updates for ${region} region`,
      },
      {
        key: `region_${region}_app_push_notifications`,
        enabled: true,
        description: `Enable push notifications for ${region} region`,
      },
      // Performance flags
      {
        key: `region_${region}_perf_extended_timeouts`,
        enabled: false,
        description: `Enable extended timeouts for ${region} region`,
      },
      {
        key: `region_${region}_perf_aggressive_caching`,
        enabled: false,
        description: `Enable aggressive caching for ${region} region`,
      },
      {
        key: `region_${region}_perf_request_batching`,
        enabled: false,
        description: `Enable request batching for ${region} region`,
      },
    );
  }

  const allFlags = [...globalFlags, ...regionFlags];

  // P5: optional per-tenant seeding. When SEED_TENANT_ID is set, the same flags
  // are upserted as that tenant's OVERRIDE rows (tenant_id = <id>) instead of
  // the global rows (tenant_id NULL). Default (unset) = global-only, identical
  // to pre-P5 behavior. The `[key, tenantId]` unique (P1) keeps each scope's
  // row distinct, and Postgres NULL-distinctness keeps the global row untouched.
  const seedTenantId = process.env.SEED_TENANT_ID?.trim() || null;
  if (seedTenantId) {
    console.log(
      `🏷️  Seeding TENANT-SCOPED toggles for tenant_id=${seedTenantId}\n`,
    );
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const flag of allFlags) {
    try {
      // Scope the existing-row lookup to the target scope (global vs tenant).
      const existing = await prisma.featureToggle.findFirst({
        where: { key: flag.key, tenantId: seedTenantId },
        select: { id: true },
      });

      if (existing) {
        // Always update to match config file values (config file is source of truth)
        // This ensures deployments overwrite database values with config values
        await prisma.featureToggle.update({
          where: { id: existing.id },
          data: {
            enabled: flag.enabled,
            description: flag.description,
            changedBy: "system@seed-script",
            lastChanged: new Date(),
          },
        });
        updated++;
        console.log(`✅ Updated: ${flag.key} (enabled: ${flag.enabled})`);
      } else {
        await prisma.featureToggle.create({
          data: {
            key: flag.key,
            enabled: flag.enabled,
            description: flag.description,
            tenantId: seedTenantId,
            changedBy: "system@seed-script",
            lastChanged: new Date(),
          },
        });
        created++;
        console.log(`✨ Created: ${flag.key}`);
      }
    } catch (error) {
      console.error(`❌ Error processing ${flag.key}:`, error);
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Created: ${created}`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Total: ${allFlags.length}\n`);

  // Verify all flags exist
  const totalInDb = await prisma.featureToggle.count();
  console.log(`📈 Total feature toggles in database: ${totalInDb}\n`);

  // Close Prisma client
  await prisma.$disconnect();
}

// Store prisma client reference for cleanup
let prismaInstance: PrismaClient | null = null;

seedFeatureToggles()
  .catch((error) => {
    console.error("❌ Error seeding feature toggles:", error);
    process.exit(1);
  })
  .finally(async () => {
    if (prismaInstance) {
      await prismaInstance.$disconnect();
    }
  });
