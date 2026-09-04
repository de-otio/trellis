/**
 * Seed the initial PlatformCategory taxonomy.
 *
 * PlatformCategory is the platform-curated, tenant-independent vocabulary that
 * every tenant classification and every directory search draws from. This seed
 * lays down a small hand-curated root set plus a handful of illustrative leaves
 * — enough for the directory-search tests to exercise hierarchy, NOT an
 * exhaustive taxonomy. The Phase 2 AI-curation pipeline is what grows this for
 * real.
 *
 * Idempotent: upserts by the unique `code`, so it is safe to re-run. Roots are
 * upserted first, then leaves (which reference their parent by `code`).
 *
 * NOTE (human checkpoint): the exact category set below is a product/content
 * decision — what categories exist at launch — not a purely technical one. Flag
 * it for review before it ships.
 *
 * Run with: npx tsx apps/api/scripts/seed-platform-categories.ts
 * Requires DIRECT_DATABASE_URL or DATABASE_URL (or AWS SSM), same as
 * seed-feature-toggles.ts.
 */

import { PrismaClient } from "@prisma/client";
import type { CategorySeed } from "../src/lib/org-category/seed-data.js";
import { ROOTS, LEAVES } from "../src/lib/org-category/seed-data.js";

// Helper to get database URL from environment or AWS SSM (mirrors
// seed-feature-toggles.ts so both scripts resolve the connection identically).
async function getDatabaseUrl(): Promise<string> {
  if (process.env.DIRECT_DATABASE_URL) {
    return process.env.DIRECT_DATABASE_URL;
  }
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  try {
    const { getSsmParameter } = await import("../test/utils/aws-ssm");
    const env = process.env.ENVIRONMENT || process.env.DEPLOY_ENV || "dev";

    const directUrl = await getSsmParameter("DIRECT_DATABASE_URL", {
      environment: env,
      required: false,
    });
    if (directUrl) {
      return directUrl;
    }

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

let prismaInstance: PrismaClient | null = null;

async function seedPlatformCategories() {
  console.log("🌱 Seeding platform categories...\n");

  const rawUrl = await getDatabaseUrl();
  // Supabase pooler (6543) is not reachable from CI runners; use direct port.
  const databaseUrl = rawUrl.replace(":6543/", ":5432/");

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  prismaInstance = prisma;

  let created = 0;
  let updated = 0;

  // Upsert a single category by its unique `code`, resolving parentCode → id.
  async function upsertCategory(seed: CategorySeed): Promise<void> {
    let parentCategoryId: string | null = null;
    if (seed.parentCode) {
      const parent = await prisma.platformCategory.findUnique({
        where: { code: seed.parentCode },
        select: { id: true },
      });
      if (!parent) {
        throw new Error(
          `Parent category "${seed.parentCode}" not found for "${seed.code}" — roots must be seeded before leaves.`,
        );
      }
      parentCategoryId = parent.id;
    }

    const existing = await prisma.platformCategory.findUnique({
      where: { code: seed.code },
      select: { id: true },
    });

    if (existing) {
      await prisma.platformCategory.update({
        where: { id: existing.id },
        data: {
          displayName: seed.displayName,
          description: seed.description ?? null,
          order: seed.order,
          isActive: true,
          parentCategoryId,
        },
      });
      updated++;
      console.log(`✅ Updated: ${seed.code}`);
    } else {
      await prisma.platformCategory.create({
        data: {
          code: seed.code,
          displayName: seed.displayName,
          description: seed.description ?? null,
          order: seed.order,
          isActive: true,
          parentCategoryId,
        },
      });
      created++;
      console.log(`✨ Created: ${seed.code}`);
    }
  }

  // Roots first (leaves resolve their parent by code), then leaves.
  for (const root of ROOTS) {
    await upsertCategory(root);
  }
  for (const leaf of LEAVES) {
    await upsertCategory(leaf);
  }

  const total = await prisma.platformCategory.count();
  console.log(`\n📊 Summary:`);
  console.log(`   Created: ${created}`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Total platform categories in database: ${total}\n`);

  await prisma.$disconnect();
}

seedPlatformCategories()
  .catch((error) => {
    console.error("❌ Error seeding platform categories:", error);
    process.exit(1);
  })
  .finally(async () => {
    if (prismaInstance) {
      await prismaInstance.$disconnect();
    }
  });
