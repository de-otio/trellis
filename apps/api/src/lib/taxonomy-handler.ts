/**
 * Taxonomy Handler
 *
 * Handles taxonomy-related operations including:
 * - Retrieving dimensions, categories, and taxons
 * - Searching taxons
 * - Managing taxonomy tags for posts, entities, and products
 */

import type { PrismaClient } from "@prisma/client";
import type { Env } from "../env.js";
import type { KVNamespace } from "../types/cloudflare-compat.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";

export interface TaxonomyDimension {
  id: string;
  tenantId: string;
  code: string;
  displayName: string;
  description: string | null;
  order: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaxonomyCategory {
  id: string;
  tenantId: string;
  dimensionId: string;
  code: string;
  displayName: string;
  description: string | null;
  order: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaxonomyTaxon {
  id: string;
  tenantId: string;
  categoryId: string;
  taxonId: string;
  displayName: string;
  description: string | null;
  order: number;
  isActive: boolean;
  synonyms: string[] | null;
  userTerms: string[] | null;
  parentTaxonId: string | null;
  translations: Record<string, any> | null;
  createdAt: Date;
  updatedAt: Date;
  category?: TaxonomyCategory & { dimension?: TaxonomyDimension }; // Include category and dimension
}

interface SearchTaxonsOptions {
  dimension?: string;
  category?: string;
  limit?: number;
}

export class TaxonomyHandler {
  private db: PrismaClient;
  private tenantId: string;
  private cacheKv?: KVNamespace;
  private logger: Logger;

  constructor(
    db: PrismaClient,
    tenantId: string,
    cacheKv?: KVNamespace,
    env?: LoggerEnv,
  ) {
    this.db = db;
    this.tenantId = tenantId;
    this.cacheKv = cacheKv;
    this.logger = getLogger();
  }

  /**
   * Get all active taxonomy dimensions for the tenant, optionally including categories and taxons.
   * OPTIMIZATION: Uses caching for frequently accessed data (1 hour TTL).
   */
  async getDimensions(options?: {
    includeCategories?: boolean;
    includeTaxons?: boolean;
  }): Promise<TaxonomyDimension[]> {
    // Build cache key based on options
    const cacheKey = `taxonomy:dimensions:${this.tenantId}:${options?.includeCategories ? "cats" : ""}:${options?.includeTaxons ? "taxons" : ""}`;

    // Try to get from cache first
    if (this.cacheKv) {
      try {
        const cached = await this.cacheKv.get(cacheKey, "json");
        if (cached) {
          return cached as TaxonomyDimension[];
        }
      } catch (error) {
        // Cache read failure is non-critical - continue to database query
        this.logger.warn(
          "[TaxonomyHandler] Cache read failed, falling back to database:",
          error,
        );
      }
    }

    // Fetch from database
    const dimensions = await this.db.taxonomyDimension.findMany({
      where: {
        tenantId: this.tenantId,
        isActive: true,
      },
      include: {
        categories: options?.includeCategories
          ? {
              where: { isActive: true },
              include: {
                taxons: options?.includeTaxons
                  ? { where: { isActive: true } }
                  : false,
              },
              orderBy: { order: "asc" },
            }
          : false,
      },
      orderBy: { order: "asc" },
    });

    // Cache the result (non-blocking)
    if (this.cacheKv) {
      try {
        await this.cacheKv.put(cacheKey, JSON.stringify(dimensions), {
          expirationTtl: 3600, // 1 hour cache
        });
      } catch (error) {
        // Cache write failure is non-critical - log but don't fail the request
        this.logger.warn("[TaxonomyHandler] Cache write failed:", error);
      }
    }

    return dimensions;
  }

  /**
   * Get a specific taxonomy dimension by its code for the tenant, optionally including categories and taxons.
   * OPTIMIZATION: Uses caching for frequently accessed data (1 hour TTL).
   */
  async getDimensionByCode(
    dimensionCode: string,
    options?: { includeCategories?: boolean; includeTaxons?: boolean },
  ): Promise<
    | (TaxonomyDimension & {
        categories?: (TaxonomyCategory & { taxons?: TaxonomyTaxon[] })[];
      })
    | null
  > {
    // Build cache key
    const cacheKey = `taxonomy:dimension:${this.tenantId}:${dimensionCode}:${options?.includeCategories ? "cats" : ""}:${options?.includeTaxons ? "taxons" : ""}`;

    // Try to get from cache first
    if (this.cacheKv) {
      try {
        const cached = await this.cacheKv.get(cacheKey, "json");
        if (cached) {
          return cached as TaxonomyDimension & {
            categories?: (TaxonomyCategory & { taxons?: TaxonomyTaxon[] })[];
          };
        }
      } catch (error) {
        // Cache read failure is non-critical - continue to database query
        this.logger.warn(
          "[TaxonomyHandler] Cache read failed, falling back to database:",
          error,
        );
      }
    }

    // Fetch from database
    const dimension = (await this.db.taxonomyDimension.findUnique({
      where: {
        tenantId_code: {
          tenantId: this.tenantId,
          code: dimensionCode,
        },
        isActive: true,
      },
      include: {
        categories: options?.includeCategories
          ? {
              where: { isActive: true },
              include: {
                taxons: options?.includeTaxons
                  ? { where: { isActive: true } }
                  : false,
              },
              orderBy: { order: "asc" },
            }
          : false,
      },
    })) as unknown as
      | (TaxonomyDimension & { categories: TaxonomyCategory[] })
      | null;

    // Cache the result (non-blocking, only if found)
    if (dimension && this.cacheKv) {
      try {
        await this.cacheKv.put(cacheKey, JSON.stringify(dimension), {
          expirationTtl: 3600, // 1 hour cache
        });
      } catch (error) {
        // Cache write failure is non-critical - log but don't fail the request
        this.logger.warn("[TaxonomyHandler] Cache write failed:", error);
      }
    }

    return dimension;
  }

  /**
   * Search taxons by query string using PostgreSQL full-text search
   *
   * Uses optimized PostgreSQL full-text search with GIN indexes for:
   * - Display names and descriptions (full-text search)
   * - Synonyms and user terms (JSON array matching)
   *
   * Includes relevance scoring and ranking. Falls back to simple Prisma query if raw SQL fails.
   */
  async searchTaxons(
    query: string,
    options: SearchTaxonsOptions = {},
  ): Promise<TaxonomyTaxon[]> {
    const limit = Math.min(options.limit || 20, 50); // Max 50 results
    const searchTerm = query.trim();

    // Early return for empty query
    if (!searchTerm || searchTerm.length === 0) {
      return [];
    }

    // Build dimension/category filter SQL
    let dimensionFilter = "";
    let categoryFilter = "";
    const params: any[] = [this.tenantId, searchTerm, limit];
    let paramIndex = 4;

    if (options.dimension) {
      dimensionFilter = `
        AND EXISTS (
          SELECT 1 FROM taxonomy_categories tc
          JOIN taxonomy_dimensions td ON tc.dimension_id = td.id
          WHERE tc.id = t.category_id
            AND td.code = $${paramIndex}
            AND td.tenant_id = $1
        )
      `;
      params.push(options.dimension);
      paramIndex++;
    }

    if (options.category) {
      categoryFilter = `
        AND EXISTS (
          SELECT 1 FROM taxonomy_categories tc
          WHERE tc.id = t.category_id
            AND tc.code = $${paramIndex}
            AND tc.tenant_id = $1
        )
      `;
      params.push(options.category);
      paramIndex++;
    }

    // Use PostgreSQL full-text search with JSON array matching
    // This leverages GIN indexes for optimal performance
    // OPTIMIZATION: Include category and dimension data in SQL to avoid second query
    const sql = `
      WITH ranked_taxons AS (
        SELECT 
          t.id,
          t.tenant_id,
          t.category_id,
          t."taxonId",
          t.display_name,
          t.description,
          t."order",
          t.is_active,
          t.synonyms,
          t."userTerms",
          t.parent_taxon_id,
          t.translations,
          t.created_at,
          t.updated_at,
          GREATEST(
            -- Full-text search ranking (weighted 2.0x)
            ts_rank(
              to_tsvector('english', t.display_name || ' ' || COALESCE(t.description, '')),
              plainto_tsquery('english', $2)
            ) * 2.0,
            -- Exact match in display name (highest priority)
            CASE WHEN LOWER(t.display_name) = LOWER($2) THEN 1.0 ELSE 0 END,
            -- Match in synonyms JSON array
            CASE WHEN t.synonyms::jsonb ? LOWER($2) THEN 0.8 ELSE 0 END,
            -- Match in user terms JSON array (column name is "userTerms" in database - camelCase)
            CASE WHEN t."userTerms"::jsonb ? LOWER($2) THEN 0.7 ELSE 0 END,
            -- Prefix match in display name
            CASE WHEN LOWER(t.display_name) LIKE LOWER($2 || '%') THEN 0.6 ELSE 0 END
          ) as relevance_score
        FROM taxonomy_taxons t
        WHERE 
          t.tenant_id = $1
          AND t.is_active = true
          AND (
            -- Full-text search match
            to_tsvector('english', t.display_name || ' ' || COALESCE(t.description, '')) 
            @@ plainto_tsquery('english', $2)
            -- OR exact/prefix match in display name
            OR LOWER(t.display_name) LIKE LOWER($2 || '%')
            -- OR match in synonyms JSON array (using ? operator for containment)
            OR t.synonyms::jsonb ? LOWER($2)
            -- OR match in user terms JSON array (column name is "userTerms" in database - camelCase)
            OR t."userTerms"::jsonb ? LOWER($2)
            -- OR contains match in description
            OR LOWER(COALESCE(t.description, '')) LIKE '%' || LOWER($2) || '%'
          )
          ${dimensionFilter}
          ${categoryFilter}
      )
      SELECT 
        rt.id,
        rt.tenant_id,
        rt.category_id,
        rt."taxonId" as taxon_id,
        rt.display_name,
        rt.description,
        rt."order",
        rt.is_active,
        rt.synonyms,
        rt."userTerms" as user_terms,
        rt.parent_taxon_id,
        rt.translations,
        rt.created_at,
        rt.updated_at,
        rt.relevance_score,
        -- Include category data
        c.id as category_id_full,
        c.code as category_code,
        c.display_name as category_display_name,
        c.description as category_description,
        c."order" as category_order,
        c.is_active as category_is_active,
        c.created_at as category_created_at,
        c.updated_at as category_updated_at,
        -- Include dimension data
        d.id as dimension_id,
        d.code as dimension_code,
        d.display_name as dimension_display_name,
        d.description as dimension_description,
        d."order" as dimension_order,
        d.is_active as dimension_is_active,
        d.created_at as dimension_created_at,
        d.updated_at as dimension_updated_at
      FROM ranked_taxons rt
      INNER JOIN taxonomy_categories c ON c.id = rt.category_id
      INNER JOIN taxonomy_dimensions d ON d.id = c.dimension_id
      ORDER BY rt.relevance_score DESC, rt."order" ASC, rt.display_name ASC
      LIMIT $3
    `;

    try {
      // Execute raw query with parameterized values for security
      const results = (await (this.db as any).$queryRawUnsafe(
        sql,
        ...params,
      )) as any[];

      if (results.length === 0) {
        return [];
      }

      // OPTIMIZATION: Map results directly from SQL (includes category/dimension data)
      // No need for second Prisma query - all data is in the SQL results
      const taxons: TaxonomyTaxon[] = results.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        categoryId: r.category_id,
        taxonId: r.taxon_id,
        displayName: r.display_name,
        description: r.description,
        order: r.order,
        isActive: r.is_active,
        synonyms: r.synonyms,
        userTerms: r.user_terms,
        parentTaxonId: r.parent_taxon_id,
        translations: r.translations,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        category: {
          id: r.category_id_full,
          tenantId: this.tenantId,
          dimensionId: r.dimension_id, // Use dimension ID from SQL result
          code: r.category_code,
          displayName: r.category_display_name,
          description: r.category_description,
          order: r.category_order,
          isActive: r.category_is_active,
          createdAt: r.category_created_at,
          updatedAt: r.category_updated_at,
          dimension: {
            id: r.dimension_id,
            tenantId: this.tenantId,
            code: r.dimension_code,
            displayName: r.dimension_display_name,
            description: r.dimension_description,
            order: r.dimension_order,
            isActive: r.dimension_is_active,
            createdAt: r.dimension_created_at,
            updatedAt: r.dimension_updated_at,
          },
        },
      }));

      // OPTIMIZATION: No need to sort - SQL already sorts by relevance_score
      // Results are already in the correct order from the SQL query
      return taxons;
    } catch (error) {
      // Fallback to simple Prisma query if raw SQL fails
      this.logger.error(
        "Error in full-text search, falling back to simple search:",
        error,
      );

      // Fallback implementation
      const searchTermLower = searchTerm.toLowerCase();
      const where: any = {
        tenantId: this.tenantId,
        isActive: true,
        OR: [
          {
            displayName: {
              contains: searchTermLower,
              mode: "insensitive",
            },
          },
          {
            description: {
              contains: searchTermLower,
              mode: "insensitive",
            },
          },
        ],
      };

      if (options.dimension) {
        where.category = {
          dimension: {
            code: options.dimension,
            tenantId: this.tenantId,
          },
        };
      }

      if (options.category) {
        where.category = {
          ...where.category,
          code: options.category,
          tenantId: this.tenantId,
        };
      }

      const taxons = (await this.db.taxonomyTaxon.findMany({
        where,
        include: {
          category: {
            include: {
              dimension: true,
            },
          },
        },
        orderBy: [{ displayName: "asc" }, { order: "asc" }],
        take: limit,
      })) as TaxonomyTaxon[];

      // Filter by synonyms and userTerms (JSON arrays) in memory
      return taxons.filter((taxon) => {
        if (
          taxon.displayName.toLowerCase().includes(searchTermLower) ||
          (taxon.description &&
            taxon.description.toLowerCase().includes(searchTermLower))
        ) {
          return true;
        }

        if (taxon.synonyms && Array.isArray(taxon.synonyms)) {
          const synonyms = taxon.synonyms as string[];
          if (synonyms.some((s) => s.toLowerCase().includes(searchTermLower))) {
            return true;
          }
        }

        if (taxon.userTerms && Array.isArray(taxon.userTerms)) {
          const userTerms = taxon.userTerms as string[];
          if (
            userTerms.some((t) => t.toLowerCase().includes(searchTermLower))
          ) {
            return true;
          }
        }

        return false;
      });
    }
  }

  /**
   * Get taxon by taxonId
   */
  async getTaxonByTaxonId(taxonId: string): Promise<TaxonomyTaxon | null> {
    return this.db.taxonomyTaxon.findFirst({
      where: {
        tenantId: this.tenantId,
        taxonId: taxonId,
        isActive: true,
      },
      include: {
        category: {
          include: {
            dimension: true,
          },
        },
      },
    }) as Promise<TaxonomyTaxon | null>;
  }

  /**
   * Add taxonomy tags to a post
   */
  async addPostTaxonomyTags(
    postId: string,
    taxonIds: string[],
    addedBy: string,
  ): Promise<void> {
    // Validate all taxons exist and belong to tenant
    const taxons = await this.db.taxonomyTaxon.findMany({
      where: {
        tenantId: this.tenantId,
        taxonId: { in: taxonIds },
        isActive: true,
      },
    });

    if (taxons.length !== taxonIds.length) {
      throw new Error("One or more taxons not found or inactive");
    }

    // Create post-taxonomy tag associations
    await this.db.postTaxonomyTag.createMany({
      data: taxons.map((taxon) => ({
        postId,
        taxonId: taxon.id,
        addedBy,
      })),
      skipDuplicates: true,
    });

    // Track usage metrics (non-blocking)
    this.trackTagUsage(
      taxons.map((t) => t.taxonId),
      addedBy,
      "post",
      postId,
    ).catch((error: any) => {
      this.logger.error("Error tracking taxonomy tag usage:", error);
      // Don't fail tag creation if metrics tracking fails
    });
  }

  /**
   * Remove taxonomy tags from a post
   */
  async removePostTaxonomyTags(
    postId: string,
    taxonIds: string[],
  ): Promise<void> {
    // Find taxons by taxonId
    const taxons = await this.db.taxonomyTaxon.findMany({
      where: {
        tenantId: this.tenantId,
        taxonId: { in: taxonIds },
      },
    });

    if (taxons.length === 0) return;

    await this.db.postTaxonomyTag.deleteMany({
      where: {
        postId,
        taxonId: { in: taxons.map((t) => t.id) },
      },
    });
  }

  /**
   * Get taxonomy tags for a post
   */
  async getPostTaxonomyTags(postId: string): Promise<TaxonomyTaxon[]> {
    const postTags = await this.db.postTaxonomyTag.findMany({
      where: { postId },
      include: {
        taxon: {
          include: {
            category: {
              include: {
                dimension: true,
              },
            },
          },
        },
      },
    });
    return postTags.map((pt) => pt.taxon as TaxonomyTaxon);
  }

  // --- Entity Taxonomy Tag Management ---

  /**
   * Add taxonomy tags to an entity (e.g., a dog profile).
   */
  async addEntityTaxonomyTags(
    entityId: string,
    taxonIds: string[],
  ): Promise<void> {
    const taxons = await this.db.taxonomyTaxon.findMany({
      where: {
        tenantId: this.tenantId,
        taxonId: { in: taxonIds },
        isActive: true,
      },
    });

    if (taxons.length !== taxonIds.length) {
      throw new Error("One or more taxons not found or inactive");
    }

    await this.db.entityTaxonomyTag.createMany({
      data: taxons.map((taxon) => ({
        entityId,
        taxonId: taxon.id,
      })),
      skipDuplicates: true,
    });

    // Track usage metrics (non-blocking)
    // Note: Entity tags don't have a userId, so we use entityId as the identifier
    this.trackTagUsage(
      taxons.map((t) => t.taxonId),
      entityId,
      "entity",
      entityId,
    ).catch((error: any) => {
      this.logger.error("Error tracking taxonomy tag usage:", error);
      // Don't fail tag creation if metrics tracking fails
    });
  }

  /**
   * Remove taxonomy tags from an entity.
   */
  async removeEntityTaxonomyTags(
    entityId: string,
    taxonIds: string[],
  ): Promise<void> {
    const taxons = await this.db.taxonomyTaxon.findMany({
      where: {
        tenantId: this.tenantId,
        taxonId: { in: taxonIds },
      },
    });

    if (taxons.length === 0) return;

    await this.db.entityTaxonomyTag.deleteMany({
      where: {
        entityId,
        taxonId: { in: taxons.map((t) => t.id) },
      },
    });
  }

  // --- Product Taxonomy Tag Management ---

  /**
   * Add taxonomy tags to a product.
   */
  async addProductTaxonomyTags(
    productId: string,
    taxonIds: string[],
  ): Promise<void> {
    const taxons = await this.db.taxonomyTaxon.findMany({
      where: {
        tenantId: this.tenantId,
        taxonId: { in: taxonIds },
        isActive: true,
      },
    });

    if (taxons.length !== taxonIds.length) {
      throw new Error("One or more taxons not found or inactive");
    }

    await this.db.productTaxonomyTag.createMany({
      data: taxons.map((taxon) => ({
        tenantId: this.tenantId,
        productId,
        taxonId: taxon.id,
      })),
      skipDuplicates: true,
    });

    // Track usage metrics (non-blocking)
    this.trackTagUsage(
      taxons.map((t) => t.taxonId),
      productId,
      "product",
      productId,
    ).catch((error: any) => {
      this.logger.error("Error tracking taxonomy tag usage:", error);
      // Don't fail tag creation if metrics tracking fails
    });
  }

  /**
   * Remove taxonomy tags from a product.
   */
  async removeProductTaxonomyTags(
    productId: string,
    taxonIds: string[],
  ): Promise<void> {
    const taxons = await this.db.taxonomyTaxon.findMany({
      where: {
        tenantId: this.tenantId,
        taxonId: { in: taxonIds },
      },
    });

    if (taxons.length === 0) return;

    await this.db.productTaxonomyTag.deleteMany({
      where: {
        tenantId: this.tenantId,
        productId,
        taxonId: { in: taxons.map((t) => t.id) },
      },
    });
  }

  /**
   * Get taxonomy tags for a product
   */
  async getProductTaxonomyTags(productId: string): Promise<TaxonomyTaxon[]> {
    const productTags = await this.db.productTaxonomyTag.findMany({
      // Scope by tenant: productId is an external Shopify string that two
      // tenants may share, so an unscoped lookup leaks tags across tenants.
      where: { tenantId: this.tenantId, productId },
      include: {
        taxon: {
          include: {
            category: {
              include: {
                dimension: true,
              },
            },
          },
        },
      },
    });

    return productTags.map((pt) => pt.taxon as TaxonomyTaxon);
  }

  /**
   * Get all taxonomy tags for an entity.
   */
  async getEntityTaxonomyTags(entityId: string): Promise<TaxonomyTaxon[]> {
    const entityTags = await this.db.entityTaxonomyTag.findMany({
      where: { entityId },
      include: {
        taxon: {
          include: {
            category: {
              include: {
                dimension: true,
              },
            },
          },
        },
      },
    });
    return entityTags.map((et) => et.taxon as TaxonomyTaxon);
  }

  /**
   * Track taxonomy tag usage for metrics (stub - non-blocking)
   * TODO: Implement actual metrics tracking
   */
  private trackTagUsage(
    taxonIds: string[],
    userId: string,
    entityType: "post" | "entity" | "product",
    entityId: string,
  ): Promise<void> {
    // Stub implementation - returns resolved promise
    // TODO: Implement actual metrics tracking
    return Promise.resolve();
  }
}
