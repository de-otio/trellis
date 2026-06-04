/**
 * Taxonomy Metrics
 *
 * Analytics and usage metrics tracking for taxonomy system.
 *
 * @see doc/requirements/taxonomy/14_analytics_usage_metrics.md
 */

import { PrismaClient, Prisma } from "@prisma/client";

export interface TaxonMetric {
  taxonId: string;
  displayName: string;
  dimension: string;
  category: string;
  usageCount: number;
  userCount: number;
  contentCount: number;
  lastUsedAt: Date | null;
}

export interface PruningCandidate {
  taxonId: string;
  displayName: string;
  reason: "unused" | "low_usage" | "single_user" | "stale" | "unknown";
  metrics: TaxonMetric;
}

export interface FreeFormTag {
  tag: string;
  usageCount: number;
  suggestedTaxon?: string;
}

export class TaxonomyMetrics {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get comprehensive metrics for all taxons
   */
  async getTaxonMetrics(
    tenantId: string,
    options?: {
      dimension?: string;
      minUsageCount?: number;
      includeUnused?: boolean;
    },
  ): Promise<TaxonMetric[]> {
    const {
      dimension,
      minUsageCount = 0,
      includeUnused = true,
    } = options || {};

    const results = await this.prisma.$queryRaw<
      Array<{
        taxon_id: string;
        display_name: string;
        dimension: string;
        category: string;
        usage_count: bigint;
        user_count: bigint;
        content_count: bigint;
        last_used_at: Date | null;
      }>
    >`
      SELECT
        t."taxonId" as taxon_id,
        t.display_name,
        d.code as dimension,
        c.code as category,
        COUNT(DISTINCT pt.id) +
        COUNT(DISTINCT et.id) +
        COUNT(DISTINCT prt.id) as usage_count,
        COUNT(DISTINCT COALESCE(pt.added_by, et.entity_id, prt.product_id)) as user_count,
        COUNT(DISTINCT pt.post_id) +
        COUNT(DISTINCT et.entity_id) +
        COUNT(DISTINCT prt.product_id) as content_count,
        GREATEST(
          MAX(pt.created_at),
          MAX(et.created_at),
          MAX(prt.created_at)
        ) as last_used_at
      FROM taxonomy_taxons t
      INNER JOIN taxonomy_categories c ON c.id = t.category_id
      INNER JOIN taxonomy_dimensions d ON d.id = c.dimension_id
      LEFT JOIN post_taxonomy_tags pt ON pt.taxon_id = t.id
      LEFT JOIN entity_taxonomy_tags et ON et.taxon_id = t.id
      LEFT JOIN product_taxonomy_tags prt ON prt.taxon_id = t.id
      WHERE t.tenant_id = ${tenantId}
        AND t.is_active = true
        ${dimension ? Prisma.sql`AND d.code = ${dimension}` : Prisma.empty}
      GROUP BY t."taxonId", t.display_name, d.code, c.code
      HAVING COUNT(DISTINCT pt.id) + COUNT(DISTINCT et.id) + COUNT(DISTINCT prt.id) >= ${minUsageCount}
        OR ${includeUnused} = true
      ORDER BY usage_count DESC, last_used_at DESC NULLS LAST
    `;

    return results.map((r) => ({
      taxonId: r.taxon_id,
      displayName: r.display_name,
      dimension: r.dimension,
      category: r.category,
      usageCount: Number(r.usage_count),
      userCount: Number(r.user_count),
      contentCount: Number(r.content_count),
      lastUsedAt: r.last_used_at,
    }));
  }

  /**
   * Get usage count for each taxon
   */
  async getTaxonUsageCounts(
    tenantId: string,
    dimension?: string,
  ): Promise<Array<{ taxonId: string; usageCount: number }>> {
    const results = await this.prisma.$queryRaw<
      Array<{
        taxon_id: string;
        usage_count: bigint;
      }>
    >`
      SELECT
        t."taxonId" as taxon_id,
        COUNT(DISTINCT pt.id) +
        COUNT(DISTINCT et.id) +
        COUNT(DISTINCT prt.id) as usage_count
      FROM taxonomy_taxons t
      LEFT JOIN post_taxonomy_tags pt ON pt.taxon_id = t.id
      LEFT JOIN entity_taxonomy_tags et ON et.taxon_id = t.id
      LEFT JOIN product_taxonomy_tags prt ON prt.taxon_id = t.id
      WHERE t.tenant_id = ${tenantId}
        AND t.is_active = true
        ${
          dimension
            ? Prisma.sql`AND t.category_id IN (
          SELECT id FROM taxonomy_categories
          WHERE dimension_id IN (
            SELECT id FROM taxonomy_dimensions
            WHERE tenant_id = ${tenantId} AND code = ${dimension}
          )
        )`
            : Prisma.empty
        }
      GROUP BY t."taxonId"
      ORDER BY usage_count DESC
    `;

    return results.map((r) => ({
      taxonId: r.taxon_id,
      usageCount: Number(r.usage_count),
    }));
  }

  /**
   * Get unique user count for each taxon
   */
  async getTaxonUserCounts(
    tenantId: string,
  ): Promise<Array<{ taxonId: string; userCount: number }>> {
    const results = await this.prisma.$queryRaw<
      Array<{
        taxon_id: string;
        user_count: bigint;
      }>
    >`
      SELECT
        t."taxonId" as taxon_id,
        COUNT(DISTINCT COALESCE(pt.added_by, et.entity_id, prt.product_id)) as user_count
      FROM taxonomy_taxons t
      LEFT JOIN post_taxonomy_tags pt ON pt.taxon_id = t.id
      LEFT JOIN entity_taxonomy_tags et ON et.taxon_id = t.id
      LEFT JOIN product_taxonomy_tags prt ON prt.taxon_id = t.id
      WHERE t.tenant_id = ${tenantId}
        AND t.is_active = true
      GROUP BY t."taxonId"
      ORDER BY user_count DESC
    `;

    return results.map((r) => ({
      taxonId: r.taxon_id,
      userCount: Number(r.user_count),
    }));
  }

  /**
   * Get last used timestamp for each taxon
   */
  async getTaxonLastUsed(
    tenantId: string,
  ): Promise<Array<{ taxonId: string; lastUsedAt: Date | null }>> {
    const results = await this.prisma.$queryRaw<
      Array<{
        taxon_id: string;
        last_used_at: Date | null;
      }>
    >`
      SELECT
        t."taxonId" as taxon_id,
        GREATEST(
          MAX(pt.created_at),
          MAX(et.created_at),
          MAX(prt.created_at)
        ) as last_used_at
      FROM taxonomy_taxons t
      LEFT JOIN post_taxonomy_tags pt ON pt.taxon_id = t.id
      LEFT JOIN entity_taxonomy_tags et ON et.taxon_id = t.id
      LEFT JOIN product_taxonomy_tags prt ON prt.taxon_id = t.id
      WHERE t.tenant_id = ${tenantId}
        AND t.is_active = true
      GROUP BY t."taxonId"
      ORDER BY last_used_at DESC NULLS LAST
    `;

    return results.map((r) => ({
      taxonId: r.taxon_id,
      lastUsedAt: r.last_used_at,
    }));
  }

  /**
   * Check for taxons that should be pruned
   */
  async checkPruningCandidates(tenantId: string): Promise<PruningCandidate[]> {
    const metrics = await this.getTaxonMetrics(tenantId, {
      includeUnused: true,
    });

    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    return metrics
      .filter((m) => {
        // Unused for 12+ months
        if (m.lastUsedAt && m.lastUsedAt < twelveMonthsAgo) {
          return true;
        }

        // Low usage
        if (m.usageCount < 5) {
          return true;
        }

        // Single user
        if (m.userCount === 1) {
          return true;
        }

        return false;
      })
      .map((m) => ({
        taxonId: m.taxonId,
        displayName: m.displayName,
        reason: this.determinePruningReason(m, twelveMonthsAgo),
        metrics: m,
      }));
  }

  private determinePruningReason(
    metric: TaxonMetric,
    twelveMonthsAgo: Date,
  ): PruningCandidate["reason"] {
    if (metric.usageCount === 0) return "unused";
    if (metric.usageCount < 5) return "low_usage";
    if (metric.userCount === 1) return "single_user";
    if (metric.lastUsedAt && metric.lastUsedAt < twelveMonthsAgo)
      return "stale";
    return "unknown";
  }

  /**
   * Get popular free-form tags that don't match taxonomy.
   *
   * Currently returns an empty array because the schema does not have a
   * free-form tags table — all tags are structured taxonomy taxons.
   * When free-form tagging is added, this method should query that table.
   */
  async getPopularFreeFormTags(
    _tenantId: string,
    _limit: number = 100,
  ): Promise<FreeFormTag[]> {
    return [];
  }
}
