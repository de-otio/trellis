/**
 * Seed the `ReportCategory` vocabulary (compliance plan 08 §2.1).
 *
 * Report categories are DEPLOYMENT data, not core vocabulary — baking one
 * country's law or one domain's concerns ("csam", "animal-cruelty") into the
 * public, jurisdiction-neutral trellis core is exactly what the data-driven
 * design avoids. So this script is data-DRIVEN:
 *
 *   - It seeds from a JSON file when `REPORT_CATEGORIES_SEED_FILE` (env) or an
 *     `--file <path>` argv is provided — this is how a deployment (e.g. skybber
 *     → Germany, Lane D) supplies its real categories.
 *   - Otherwise it seeds a small NEUTRAL example set (one category per
 *     RoutingClass, generic labels, no jurisdiction/domain strings) — enough to
 *     exercise the routing mechanism end-to-end.
 *
 * Idempotent: upserts by the unique `key`, safe to re-run.
 *
 * Run with: npx tsx apps/api/scripts/seed-report-categories.ts
 *           REPORT_CATEGORIES_SEED_FILE=./germany-report-categories.json \
 *             npx tsx apps/api/scripts/seed-report-categories.ts
 * Requires DIRECT_DATABASE_URL or DATABASE_URL (or AWS SSM), same as
 * seed-platform-categories.ts.
 */

import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { ROUTING_CLASSES, type RoutingClass } from "../src/lib/report-templates.js";

interface ReportCategorySeed {
  key: string;
  routingClass: RoutingClass;
  /** Localized display names, e.g. { "en": "...", "de": "..." }. */
  labels: Record<string, string>;
  active?: boolean;
  sortOrder?: number;
}

// Neutral fallback set — jurisdiction- and domain-free. A deployment overrides
// this via a seed file. One per RoutingClass so the routing path is exercised.
const NEUTRAL_DEFAULTS: ReportCategorySeed[] = [
  {
    key: "illegal-priority",
    routingClass: "ILLEGAL_PRIORITY",
    labels: { en: "Illegal content (priority)" },
    sortOrder: 0,
  },
  {
    key: "illegal-content",
    routingClass: "ILLEGAL",
    labels: { en: "Illegal content" },
    sortOrder: 1,
  },
  {
    key: "policy-violation",
    routingClass: "POLICY_VIOLATION",
    labels: { en: "Policy violation" },
    sortOrder: 2,
  },
  {
    key: "moderation-appeal",
    routingClass: "FEEDBACK",
    labels: { en: "Moderation appeal / feedback" },
    sortOrder: 3,
  },
];

async function getDatabaseUrl(): Promise<string> {
  if (process.env.DIRECT_DATABASE_URL) return process.env.DIRECT_DATABASE_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  try {
    const { getSsmParameter } = await import("../test/utils/aws-ssm");
    const env = process.env.ENVIRONMENT || process.env.DEPLOY_ENV || "dev";
    const directUrl = await getSsmParameter("DIRECT_DATABASE_URL", {
      environment: env,
      required: false,
    });
    if (directUrl) return directUrl;
    const dbUrl = await getSsmParameter("DATABASE_URL", {
      environment: env,
      required: false,
    });
    if (dbUrl) return dbUrl;
  } catch (error) {
    console.warn(
      "⚠️  Could not fetch from AWS SSM:",
      error instanceof Error ? error.message : String(error),
    );
  }

  throw new Error(
    "DIRECT_DATABASE_URL or DATABASE_URL must be set in environment variables " +
      "or available in AWS SSM Parameter Store.",
  );
}

function resolveSeedFilePath(): string | undefined {
  const fileArgIdx = process.argv.indexOf("--file");
  if (fileArgIdx !== -1 && process.argv[fileArgIdx + 1]) {
    return process.argv[fileArgIdx + 1];
  }
  return process.env.REPORT_CATEGORIES_SEED_FILE || undefined;
}

function validateSeeds(raw: unknown): ReportCategorySeed[] {
  if (!Array.isArray(raw)) {
    throw new Error("Seed file must contain a JSON array of categories.");
  }
  return raw.map((item, i) => {
    const c = item as Partial<ReportCategorySeed>;
    if (typeof c.key !== "string" || !/^[a-z][a-z0-9:-]*$/.test(c.key)) {
      throw new Error(`Category #${i}: invalid or missing "key".`);
    }
    if (!ROUTING_CLASSES.includes(c.routingClass as RoutingClass)) {
      throw new Error(
        `Category "${c.key}": routingClass must be one of ${ROUTING_CLASSES.join(", ")}.`,
      );
    }
    if (typeof c.labels !== "object" || c.labels === null) {
      throw new Error(`Category "${c.key}": "labels" must be an object.`);
    }
    return {
      key: c.key,
      routingClass: c.routingClass as RoutingClass,
      labels: c.labels as Record<string, string>,
      active: c.active,
      sortOrder: c.sortOrder,
    };
  });
}

async function loadSeeds(): Promise<{ seeds: ReportCategorySeed[]; source: string }> {
  const filePath = resolveSeedFilePath();
  if (filePath) {
    const contents = await readFile(filePath, "utf8");
    return { seeds: validateSeeds(JSON.parse(contents)), source: filePath };
  }
  return { seeds: NEUTRAL_DEFAULTS, source: "neutral defaults (no seed file)" };
}

let prismaInstance: PrismaClient | null = null;

async function seedReportCategories(): Promise<void> {
  console.log("🌱 Seeding report categories...\n");

  const { seeds, source } = await loadSeeds();
  console.log(`   Source: ${source}\n`);

  const rawUrl = await getDatabaseUrl();
  const databaseUrl = rawUrl.replace(":6543/", ":5432/");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  prismaInstance = prisma;

  let created = 0;
  let updated = 0;

  for (const seed of seeds) {
    const existing = await prisma.reportCategory.findUnique({
      where: { key: seed.key },
      select: { key: true },
    });
    await prisma.reportCategory.upsert({
      where: { key: seed.key },
      create: {
        key: seed.key,
        routingClass: seed.routingClass,
        labels: seed.labels,
        active: seed.active ?? true,
        sortOrder: seed.sortOrder ?? 0,
      },
      update: {
        routingClass: seed.routingClass,
        labels: seed.labels,
        active: seed.active ?? true,
        sortOrder: seed.sortOrder ?? 0,
      },
    });
    if (existing) {
      updated++;
      console.log(`✅ Updated: ${seed.key} (${seed.routingClass})`);
    } else {
      created++;
      console.log(`✨ Created: ${seed.key} (${seed.routingClass})`);
    }
  }

  const total = await prisma.reportCategory.count();
  console.log(`\n📊 Summary:`);
  console.log(`   Created: ${created}`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Total report categories in database: ${total}\n`);

  await prisma.$disconnect();
}

seedReportCategories()
  .catch((error) => {
    console.error("❌ Error seeding report categories:", error);
    process.exit(1);
  })
  .finally(async () => {
    if (prismaInstance) await prismaInstance.$disconnect();
  });
