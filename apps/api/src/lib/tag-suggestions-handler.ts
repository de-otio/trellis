/**
 * Tag Suggestions Handler
 *
 * Provides tag suggestions for posts based on content analysis.
 * Currently implements keyword-based suggestions; ML-based suggestions can be added later.
 */

import { TaxonomyHandler } from "./taxonomy-handler.js";
import type { PrismaClient } from "@prisma/client";

export interface TagSuggestion {
  taxonId: string;
  displayName: string;
  description: string | null;
  confidence: number; // 0-1, higher = more confident
  reason: string; // Why this tag was suggested
}

export class TagSuggestionsHandler {
  private taxonomyHandler: TaxonomyHandler;

  constructor(taxonomyHandler: TaxonomyHandler) {
    this.taxonomyHandler = taxonomyHandler;
  }

  /**
   * Generate tag suggestions based on post text
   *
   * @param postText - The post text to analyze
   * @param options - Options for suggestion generation
   * @returns Array of tag suggestions sorted by confidence
   */
  async suggestTagsFromText(
    postText: string,
    options: {
      limit?: number;
      minConfidence?: number;
    } = {},
  ): Promise<TagSuggestion[]> {
    const limit = options.limit || 10;
    const minConfidence = options.minConfidence || 0.3;

    // Extract keywords from text
    const keywords = this.extractKeywords(postText);

    if (keywords.length === 0) {
      return [];
    }

    // Search taxonomy for matching taxons
    const suggestions: TagSuggestion[] = [];

    for (const keyword of keywords) {
      // Search for taxons matching this keyword
      const matchingTaxons = await this.taxonomyHandler.searchTaxons(keyword, {
        limit: 5,
      });

      for (const taxon of matchingTaxons) {
        // Calculate confidence based on match type
        let confidence = 0.5; // Base confidence
        let reason = `Matches keyword "${keyword}"`;

        // Higher confidence for exact display name matches
        if (taxon.displayName.toLowerCase().includes(keyword.toLowerCase())) {
          confidence = 0.8;
          reason = `Display name contains "${keyword}"`;
        }

        // Higher confidence for synonym matches
        if (taxon.synonyms && Array.isArray(taxon.synonyms)) {
          const synonyms = taxon.synonyms as string[];
          if (synonyms.some((s) => s.toLowerCase() === keyword.toLowerCase())) {
            confidence = 0.9;
            reason = `Synonym match: "${keyword}"`;
          }
        }

        // Higher confidence for user term matches
        if (taxon.userTerms && Array.isArray(taxon.userTerms)) {
          const userTerms = taxon.userTerms as string[];
          if (
            userTerms.some((t) => t.toLowerCase() === keyword.toLowerCase())
          ) {
            confidence = 0.85;
            reason = `User term match: "${keyword}"`;
          }
        }

        // Check if already suggested (avoid duplicates)
        const existingIndex = suggestions.findIndex(
          (s) => s.taxonId === taxon.taxonId,
        );

        if (existingIndex >= 0) {
          // Update if higher confidence
          if (confidence > suggestions[existingIndex].confidence) {
            suggestions[existingIndex] = {
              taxonId: taxon.taxonId,
              displayName: taxon.displayName,
              description: taxon.description,
              confidence,
              reason,
            };
          }
        } else {
          suggestions.push({
            taxonId: taxon.taxonId,
            displayName: taxon.displayName,
            description: taxon.description,
            confidence,
            reason,
          });
        }
      }
    }

    // Filter by minimum confidence and sort by confidence (descending)
    return suggestions
      .filter((s) => s.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
  }

  /**
   * Extract keywords from text
   *
   * @param text - Text to extract keywords from
   * @returns Array of keywords (lowercase, filtered)
   */
  private extractKeywords(text: string): string[] {
    // Common stop words to filter out
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
      "from",
      "as",
      "is",
      "was",
      "are",
      "were",
      "been",
      "be",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "must",
      "can",
      "this",
      "that",
      "these",
      "those",
      "i",
      "you",
      "he",
      "she",
      "it",
      "we",
      "they",
      "my",
      "your",
      "his",
      "her",
      "its",
      "our",
      "their",
      "me",
      "him",
      "us",
      "them",
    ]);

    // Extract words (alphanumeric + hyphens, min 3 chars)
    const words = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ") // Replace punctuation with spaces
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !stopWords.has(word));

    // Remove duplicates and return
    return Array.from(new Set(words));
  }

  /**
   * Get popular taxonomy tags (most used tags)
   *
   * @param limit - Maximum number of tags to return
   * @returns Array of popular taxons
   */
  async getPopularTags(limit: number = 10): Promise<TagSuggestion[]> {
    // TODO: Implement usage-based popular tags
    // For now, return empty array - this can be enhanced with metrics
    return [];
  }

  /**
   * Get user's frequently used tags
   *
   * @param userId - User ID
   * @param limit - Maximum number of tags to return
   * @returns Array of user's frequently used taxons
   */
  async getUserFrequentTags(
    userId: string,
    limit: number = 10,
  ): Promise<TagSuggestion[]> {
    // TODO: Implement user-specific frequent tags
    // For now, return empty array - this can be enhanced with user metrics
    return [];
  }
}
