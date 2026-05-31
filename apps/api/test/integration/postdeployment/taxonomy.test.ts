/**
 * Integration Tests: Taxonomy System
 *
 * ⚠️ SKIPPED: This test requires direct database connections which violate test architecture.
 *
 * These tests should be refactored to use HTTP API endpoints instead of direct
 * database access. The taxonomy API endpoints are available at:
 * - GET /api/taxonomy/dimensions
 * - GET /api/taxonomy/dimensions/:dimensionCode
 * - GET /api/taxonomy/taxons/search
 * - GET /api/taxonomy/taxons/:taxonId
 *
 * TODO: Convert to API-based tests using the taxonomy endpoints above.
 *
 * Original purpose:
 * Tests taxonomy business logic with real database connections.
 * These tests require a deployed database and should run post-deployment.
 */

import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TaxonomyHandler } from "../../../src/lib/taxonomy-handler.js";
// seedTaxonomyForTenant was provided by the vertical extension (the vertical extension).
// This test is skipped and needs conversion to API-based tests.
const seedTaxonomyForTenant = async (..._args: any[]) => { throw new Error("Not available in core"); };

// ⚠️ WARNING: Direct database connections not allowed in post-deployment tests
// TODO: Convert to API-based tests
// Skip by default — SSM paths for DATABASE_URL point to old Supabase/Hyperdrive URLs that no longer exist.
// This test should be converted to use HTTP API taxonomy endpoints instead of direct DB access.
describe.skip("Taxonomy Integration Tests", () => {
  let prisma: PrismaClient;
  const tenantId = "test-taxonomy-tenant";

  beforeAll(async () => {
    const { getSsmParameter } = await import("../../utils/aws-ssm.js");

    // For post-deployment tests, prioritize SSM over environment variables
    let databaseUrl: string | null = null;

    // First, try SSM (most reliable for post-deployment tests)
    try {
      const directUrl = await getSsmParameter("DIRECT_DATABASE_URL", {
        required: false,
      });
      if (
        directUrl &&
        !directUrl.includes("test-hyperdrive-id") &&
        !directUrl.includes("test-hyperdrive")
      ) {
        databaseUrl = directUrl;
        console.log("[taxonomy.test] Using DIRECT_DATABASE_URL from SSM");
      } else {
        const url = await getSsmParameter("DATABASE_URL", { required: false });
        if (
          url &&
          !url.includes("test-hyperdrive-id") &&
          !url.includes("test-hyperdrive")
        ) {
          databaseUrl = url;
          console.log("[taxonomy.test] Using DATABASE_URL from SSM");
        }
      }
    } catch (error) {
      console.warn(
        "[taxonomy.test] Failed to get database URL from SSM:",
        error,
      );
    }

    // Then check environment variables (but skip test URLs)
    if (!databaseUrl) {
      if (
        process.env.DIRECT_DATABASE_URL &&
        !process.env.DIRECT_DATABASE_URL.includes("test-hyperdrive-id") &&
        !process.env.DIRECT_DATABASE_URL.includes("test-hyperdrive")
      ) {
        databaseUrl = process.env.DIRECT_DATABASE_URL;
        console.log(
          "[taxonomy.test] Using DIRECT_DATABASE_URL from environment",
        );
      } else if (
        process.env.DATABASE_URL &&
        !process.env.DATABASE_URL.includes("test-hyperdrive-id") &&
        !process.env.DATABASE_URL.includes("test-hyperdrive")
      ) {
        databaseUrl = process.env.DATABASE_URL;
        console.log("[taxonomy.test] Using DATABASE_URL from environment");
      }
    }

    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL or DIRECT_DATABASE_URL must be set and must not be a test URL",
      );
    }

    // Validate URL is not a test URL (double-check)
    if (
      databaseUrl.includes("test-hyperdrive-id") ||
      databaseUrl.includes("test-hyperdrive")
    ) {
      throw new Error(
        `Test database URL detected: ${databaseUrl.substring(0, 50)}... Use DIRECT_DATABASE_URL from SSM or environment.`,
      );
    }

    // Use helper function to process database URL (handles port conversion, SSL, and IPv4 in CI)
    const { getDatabaseUrlWithFallback, ensureSslConnection } = await import(
      "../../utils/test-auth.js"
    );

    // Convert pooler port (6543) to direct port (5432) and force IPv4 in CI
    // getDatabaseUrlWithFallback already handles IPv4 conversion in CI
    let processedUrl = await getDatabaseUrlWithFallback(databaseUrl);

    // Ensure SSL for Supabase
    processedUrl = ensureSslConnection(processedUrl);

    prisma = new PrismaClient({
      datasources: {
        db: {
          url: processedUrl,
        },
      },
    });

    // Test connection with retry
    let retries = 3;
    while (retries > 0) {
      try {
        await prisma.$connect();
        break;
      } catch (error: any) {
        retries--;
        if (retries === 0) {
          throw new Error(
            `Failed to connect to database after 3 retries: ${error.message}`,
          );
        }
        // Wait before retry (exponential backoff)
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (4 - retries)),
        );
      }
    }

    // Seed taxonomy for test tenant
    await seedTaxonomyForTenant(prisma, tenantId);
  }, 30000); // 30 second timeout for connection setup

  afterAll(async () => {
    if (!prisma) {
      console.warn("[taxonomy.test] Prisma client not initialized, skipping cleanup");
      return;
    }
    // Cleanup: Remove test tenant taxonomy
    await prisma.taxonomyTaxon.deleteMany({
      where: { tenantId },
    });
    await prisma.taxonomyCategory.deleteMany({
      where: { tenantId },
    });
    await prisma.taxonomyDimension.deleteMany({
      where: { tenantId },
    });
    await prisma.$disconnect();
  });

  describe("TaxonomyHandler", () => {
    let handler: TaxonomyHandler;

    beforeEach(() => {
      handler = new TaxonomyHandler(prisma, tenantId);
    });

    describe("getDimensions", () => {
      it("should return all dimensions", async () => {
        const dimensions = await handler.getDimensions();

        expect(dimensions).toBeInstanceOf(Array);
        expect(dimensions.length).toBeGreaterThan(0);
        expect(dimensions[0]).toHaveProperty("code");
        expect(dimensions[0]).toHaveProperty("displayName");
        expect(dimensions[0]).toHaveProperty("tenantId", tenantId);
      });

      it("should include categories when requested", async () => {
        const dimensions = await handler.getDimensions({
          includeCategories: true,
        });

        expect(dimensions.length).toBeGreaterThan(0);
        const dimensionWithCategories = dimensions.find(
          (d) => d.categories && d.categories.length > 0,
        );
        expect(dimensionWithCategories).toBeDefined();
        expect(dimensionWithCategories!.categories).toBeInstanceOf(Array);
      });

      it("should include taxons when requested", async () => {
        const dimensions = await handler.getDimensions({
          includeCategories: true,
          includeTaxons: true,
        });

        expect(dimensions.length).toBeGreaterThan(0);
        const dimensionWithTaxons = dimensions.find(
          (d) =>
            d.categories &&
            d.categories.some((c: any) => c.taxons && c.taxons.length > 0),
        );
        expect(dimensionWithTaxons).toBeDefined();
      });
    });

    describe("getDimensionByCode", () => {
      it("should return dimension by code", async () => {
        const dimension = await handler.getDimensionByCode("behavior");

        expect(dimension).toBeDefined();
        expect(dimension?.code).toBe("behavior");
        expect(dimension?.tenantId).toBe(tenantId);
      });

      it("should return null for non-existent dimension", async () => {
        const dimension = await handler.getDimensionByCode(
          "nonexistent-dimension",
        );

        expect(dimension).toBeNull();
      });
    });

    describe("searchTaxons", () => {
      it("should search taxons by display name", async () => {
        const taxons = await handler.searchTaxons("recall");

        expect(taxons).toBeInstanceOf(Array);
        expect(taxons.length).toBeGreaterThan(0);
        expect(taxons[0]).toHaveProperty("taxonId");
        expect(taxons[0]).toHaveProperty("displayName");
        // Should find "Recall Training"
        const recallTaxon = taxons.find(
          (t) => t.taxonId === "behavior:training:recall",
        );
        expect(recallTaxon).toBeDefined();
      });

      it("should search taxons by synonyms", async () => {
        // Search for a synonym of "Recall Training" which has synonym "come"
        const taxons = await handler.searchTaxons("come");

        expect(taxons.length).toBeGreaterThan(0);
        const recallTaxon = taxons.find(
          (t) => t.taxonId === "behavior:training:recall",
        );
        expect(recallTaxon).toBeDefined();
      });

      it("should filter by dimension", async () => {
        const taxons = await handler.searchTaxons("training", {
          dimension: "behavior",
        });

        expect(taxons.length).toBeGreaterThan(0);
        taxons.forEach((taxon) => {
          expect(taxon.taxonId).toMatch(/^behavior:/);
        });
      });

      it("should respect limit", async () => {
        const taxons = await handler.searchTaxons("training", { limit: 5 });

        expect(taxons.length).toBeLessThanOrEqual(5);
      });
    });

    describe("getTaxonByTaxonId", () => {
      it("should return taxon by taxonId", async () => {
        const taxon = await handler.getTaxonByTaxonId(
          "behavior:training:recall",
        );

        expect(taxon).toBeDefined();
        expect(taxon?.taxonId).toBe("behavior:training:recall");
        expect(taxon?.displayName).toBe("Recall Training");
        expect(taxon?.tenantId).toBe(tenantId);
      });

      it("should return null for non-existent taxon", async () => {
        const taxon = await handler.getTaxonByTaxonId("nonexistent:taxon:id");

        expect(taxon).toBeNull();
      });
    });
  });

  describe("Taxonomy Tagging", () => {
    let handler: TaxonomyHandler;
    let testPostId: string;
    let testEntityId: string;
    let testUserId: string;

    beforeEach(async () => {
      handler = new TaxonomyHandler(prisma, tenantId);

      // Create test user first (required for foreign key constraints)
      const user = await prisma.user.upsert({
        where: { id: "test-taxonomy-user-id" },
        update: {},
        create: {
          id: "test-taxonomy-user-id",
          email: "test-taxonomy@example.com",
          role: "END_USER",
          dataRegion: "US", // Required field
        },
      });
      testUserId = user.id;

      // Create test post
      const post = await prisma.post.create({
        data: {
          text: "Test post for taxonomy tagging",
          authorId: testUserId,
          visibility: "PUBLIC",
          dataRegion: "US", // Required field
        },
      });
      testPostId = post.id;

      // Create test entity
      const entity = await prisma.entity.create({
        data: {
          name: "Test Dog",
          entityType: "dog",
          ownerId: testUserId,
          metadata: {},
        },
      });
      testEntityId = entity.id;
    });

    afterEach(async () => {
      // Cleanup test data
      await prisma.postTaxonomyTag.deleteMany({
        where: { postId: testPostId },
      });
      await prisma.entityTaxonomyTag.deleteMany({
        where: { entityId: testEntityId },
      });
      await prisma.post.delete({
        where: { id: testPostId },
      });
      await prisma.entity.delete({
        where: { id: testEntityId },
      });
    });

    describe("Post Taxonomy Tags", () => {
      it("should add taxonomy tags to post", async () => {
        const taxonIds = ["behavior:training:recall", "life-stage:puppy"];

        await handler.addPostTaxonomyTags(testPostId, taxonIds, testUserId);

        const tags = await handler.getPostTaxonomyTags(testPostId);
        expect(tags.length).toBe(2);
        expect(tags.map((t) => t.taxonId)).toContain(
          "behavior:training:recall",
        );
        expect(tags.map((t) => t.taxonId)).toContain("life-stage:puppy");
      });

      it("should remove taxonomy tags from post", async () => {
        await handler.addPostTaxonomyTags(
          testPostId,
          ["behavior:training:recall"],
          testUserId,
        );

        await handler.removePostTaxonomyTags(testPostId, [
          "behavior:training:recall",
        ]);

        const tags = await handler.getPostTaxonomyTags(testPostId);
        expect(tags.length).toBe(0);
      });

      it("should not add duplicate tags", async () => {
        await handler.addPostTaxonomyTags(
          testPostId,
          ["behavior:training:recall"],
          testUserId,
        );
        await handler.addPostTaxonomyTags(
          testPostId,
          ["behavior:training:recall"],
          testUserId,
        );

        const tags = await handler.getPostTaxonomyTags(testPostId);
        expect(tags.length).toBe(1);
      });
    });

    describe("Entity Taxonomy Tags", () => {
      it("should add taxonomy tags to entity", async () => {
        const taxonIds = ["behavior:training:recall", "context:location:park"];

        await handler.addEntityTaxonomyTags(testEntityId, taxonIds);

        const tags = await handler.getEntityTaxonomyTags(testEntityId);
        expect(tags.length).toBe(2);
        expect(tags.map((t) => t.taxonId)).toContain(
          "behavior:training:recall",
        );
        expect(tags.map((t) => t.taxonId)).toContain("context:location:park");
      });

      it("should remove taxonomy tags from entity", async () => {
        await handler.addEntityTaxonomyTags(testEntityId, [
          "behavior:training:recall",
        ]);

        await handler.removeEntityTaxonomyTags(testEntityId, [
          "behavior:training:recall",
        ]);

        const tags = await handler.getEntityTaxonomyTags(testEntityId);
        expect(tags.length).toBe(0);
      });
    });
  });
});
