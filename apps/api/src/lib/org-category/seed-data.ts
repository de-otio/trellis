/**
 * Seed data for the initial `PlatformCategory` taxonomy.
 *
 * PlatformCategory is the platform-curated, tenant-independent vocabulary that
 * every tenant classification and every directory search draws from. This
 * data is a small hand-curated root set plus a handful of illustrative leaves
 * — enough for the directory-search tests to exercise hierarchy, NOT an
 * exhaustive taxonomy. The Phase 2 AI-curation pipeline is what grows this for
 * real.
 *
 * NOTE (human checkpoint): the exact category set below is a product/content
 * decision — what categories exist at launch — not a purely technical one.
 * Flag it for review before it ships.
 *
 * This module is pure data with no side effects: it does not touch the
 * database and does not import Prisma. `apps/api/scripts/seed-platform-categories.ts`
 * imports `PLATFORM_CATEGORY_SEED` and performs the upserts; tests import the
 * same array to assert structural invariants without running a seed.
 */

export interface CategorySeed {
  code: string;
  displayName: string;
  description?: string;
  order: number;
  /** Parent category `code`; undefined for a root. */
  parentCode?: string;
}

// Root set — the top-level classification axis. Hand-curated (see 05-schema-changes.md).
export const ROOTS: CategorySeed[] = [
  { code: "business", displayName: "Business", order: 0, description: "For-profit companies, sole traders, and commercial services." },
  { code: "nonprofit", displayName: "Nonprofit", order: 1, description: "Charities, NGOs, foundations, and other not-for-profit organizations." },
  { code: "community-group", displayName: "Community Group", order: 2, description: "Informal community groups, clubs, and grassroots collectives." },
  { code: "government", displayName: "Government", order: 3, description: "Public bodies, agencies, and government services." },
  { code: "educational", displayName: "Educational", order: 4, description: "Schools, universities, and other educational institutions." },
  { code: "other", displayName: "Other", order: 5, description: "Fallback root for organizations that fit none of the above." },
];

// A handful of illustrative leaves — just enough to exercise hierarchy in the
// directory-search tests. Deliberately NOT exhaustive.
export const LEAVES: CategorySeed[] = [
  { code: "business:retail", displayName: "Retail", order: 0, parentCode: "business" },
  { code: "business:hospitality", displayName: "Hospitality", order: 1, parentCode: "business" },
  { code: "business:professional-services", displayName: "Professional Services", order: 2, parentCode: "business" },
  { code: "nonprofit:animal-welfare", displayName: "Animal Welfare", order: 0, parentCode: "nonprofit" },
  { code: "nonprofit:environment", displayName: "Environment", order: 1, parentCode: "nonprofit" },
  { code: "nonprofit:education", displayName: "Education & Youth", order: 2, parentCode: "nonprofit" },
];

/**
 * The full seed set in upsert order: roots first, then leaves — the script's
 * roots-before-leaves precondition, expressed once here instead of re-derived
 * at every call site.
 */
export const PLATFORM_CATEGORY_SEED: readonly CategorySeed[] = [...ROOTS, ...LEAVES];
