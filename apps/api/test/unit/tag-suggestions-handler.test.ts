/**
 * Unit Tests: Tag Suggestions Handler
 *
 * Tests for tag suggestion generation based on content analysis.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TagSuggestionsHandler } from "../../src/lib/tag-suggestions-handler.js";
import { TaxonomyHandler } from "../../src/lib/taxonomy-handler.js";

describe("TagSuggestionsHandler", () => {
  let handler: TagSuggestionsHandler;
  let mockTaxonomyHandler: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTaxonomyHandler = {
      searchTaxons: vi.fn(),
    };

    handler = new TagSuggestionsHandler(
      mockTaxonomyHandler as unknown as TaxonomyHandler,
    );
  });

  describe("extractKeywords", () => {
    it("should extract keywords from text", () => {
      const text = "Teaching my puppy recall training at the park";
      const keywords = (handler as any).extractKeywords(text);

      expect(keywords.length).toBeGreaterThan(0);
      expect(keywords).toContain("teaching");
      expect(keywords).toContain("puppy");
      expect(keywords).toContain("recall");
      expect(keywords).toContain("training");
      expect(keywords).toContain("park");
    });

    it("should filter out stop words", () => {
      const text = "the dog is at the park";
      const keywords = (handler as any).extractKeywords(text);

      expect(keywords).not.toContain("the");
      expect(keywords).not.toContain("is");
      expect(keywords).not.toContain("at");
      expect(keywords).toContain("dog");
      expect(keywords).toContain("park");
    });

    it("should filter out words shorter than 3 characters", () => {
      const text = "my dog is ok";
      const keywords = (handler as any).extractKeywords(text);

      expect(keywords).not.toContain("my");
      expect(keywords).not.toContain("is");
      expect(keywords).not.toContain("ok");
      expect(keywords).toContain("dog");
    });

    it("should handle empty text", () => {
      const keywords = (handler as any).extractKeywords("");
      expect(keywords).toEqual([]);
    });

    it("should remove duplicates", () => {
      const text = "recall recall training training";
      const keywords = (handler as any).extractKeywords(text);

      const recallCount = keywords.filter((k: string) => k === "recall").length;
      const trainingCount = keywords.filter(
        (k: string) => k === "training",
      ).length;

      expect(recallCount).toBe(1);
      expect(trainingCount).toBe(1);
    });

    it("should handle punctuation", () => {
      const text = "Teaching my puppy! Recall training? At the park.";
      const keywords = (handler as any).extractKeywords(text);

      expect(keywords.length).toBeGreaterThan(0);
      expect(keywords.every((k: string) => /^[a-z-]+$/.test(k))).toBe(true);
    });
  });

  describe("suggestTagsFromText", () => {
    it("should return empty array for empty text", async () => {
      mockTaxonomyHandler.searchTaxons.mockResolvedValue([]);

      const suggestions = await handler.suggestTagsFromText("");

      expect(suggestions).toEqual([]);
      expect(mockTaxonomyHandler.searchTaxons).not.toHaveBeenCalled();
    });

    it("should return suggestions based on keyword matches", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Coming when called",
          synonyms: ["come"],
          userTerms: ["coming-when-called"],
        },
        {
          id: "taxon-2",
          taxonId: "life-stage:puppy",
          displayName: "Puppy",
          description: "Young puppies",
          synonyms: null,
          userTerms: null,
        },
      ];

      mockTaxonomyHandler.searchTaxons.mockResolvedValue(mockTaxons);

      const suggestions = await handler.suggestTagsFromText(
        "Teaching my puppy recall training",
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(
        suggestions.some((s) => s.taxonId === "behavior:training:recall"),
      ).toBe(true);
    });

    it("should assign higher confidence for exact display name matches", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Coming when called",
          synonyms: null,
          userTerms: null,
        },
      ];

      mockTaxonomyHandler.searchTaxons.mockResolvedValue(mockTaxons);

      const suggestions = await handler.suggestTagsFromText("recall training");

      expect(suggestions.length).toBeGreaterThan(0);
      const recallSuggestion = suggestions.find(
        (s) => s.taxonId === "behavior:training:recall",
      );
      expect(recallSuggestion?.confidence).toBeGreaterThanOrEqual(0.8);
      expect(recallSuggestion?.reason).toContain("Display name");
    });

    it("should assign higher confidence for synonym matches", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Coming when called",
          synonyms: ["come", "off-leash-training"],
          userTerms: null,
        },
      ];

      mockTaxonomyHandler.searchTaxons.mockResolvedValue(mockTaxons);

      const suggestions = await handler.suggestTagsFromText("come");

      expect(suggestions.length).toBeGreaterThan(0);
      const recallSuggestion = suggestions.find(
        (s) => s.taxonId === "behavior:training:recall",
      );
      expect(recallSuggestion?.confidence).toBeGreaterThanOrEqual(0.9);
      expect(recallSuggestion?.reason).toContain("Synonym");
    });

    it("should assign higher confidence for user term matches", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Coming when called",
          synonyms: null,
          userTerms: ["coming-when-called"],
        },
      ];

      mockTaxonomyHandler.searchTaxons.mockResolvedValue(mockTaxons);

      const suggestions =
        await handler.suggestTagsFromText("coming-when-called");

      expect(suggestions.length).toBeGreaterThan(0);
      const recallSuggestion = suggestions.find(
        (s) => s.taxonId === "behavior:training:recall",
      );
      expect(recallSuggestion?.confidence).toBeGreaterThanOrEqual(0.85);
      expect(recallSuggestion?.reason).toContain("User term");
    });

    it("should avoid duplicate suggestions", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Coming when called",
          synonyms: ["come"],
          userTerms: null,
        },
      ];

      // Mock to return same taxon for multiple keywords
      mockTaxonomyHandler.searchTaxons.mockResolvedValue(mockTaxons);

      const suggestions = await handler.suggestTagsFromText("recall come");

      const recallSuggestions = suggestions.filter(
        (s) => s.taxonId === "behavior:training:recall",
      );
      expect(recallSuggestions.length).toBe(1);
    });

    it("should update confidence if duplicate found with higher confidence", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Coming when called",
          synonyms: ["come"],
          userTerms: null,
        },
      ];

      mockTaxonomyHandler.searchTaxons.mockResolvedValue(mockTaxons);

      const suggestions = await handler.suggestTagsFromText("recall come");

      const recallSuggestion = suggestions.find(
        (s) => s.taxonId === "behavior:training:recall",
      );
      // Should have higher confidence from synonym match
      expect(recallSuggestion?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("should respect limit parameter", async () => {
      const manyTaxons = Array.from({ length: 30 }, (_, i) => ({
        id: `taxon-${i}`,
        taxonId: `behavior:training:taxon-${i}`,
        displayName: `Taxon ${i}`,
        description: null,
        synonyms: null,
        userTerms: null,
      }));

      mockTaxonomyHandler.searchTaxons.mockResolvedValue(manyTaxons);

      const suggestions = await handler.suggestTagsFromText("training", {
        limit: 5,
      });

      expect(suggestions.length).toBeLessThanOrEqual(5);
    });

    it("should filter by minimum confidence", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Coming when called",
          synonyms: null,
          userTerms: null,
        },
      ];

      mockTaxonomyHandler.searchTaxons.mockResolvedValue(mockTaxons);

      const suggestions = await handler.suggestTagsFromText("xyz", {
        minConfidence: 0.8,
      });

      // Low confidence matches should be filtered out
      expect(suggestions.length).toBe(0);
    });

    it("should sort suggestions by confidence (descending)", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Coming when called",
          synonyms: null,
          userTerms: null,
        },
        {
          id: "taxon-2",
          taxonId: "behavior:training:basic-obedience",
          displayName: "Basic Obedience",
          description: "Sit, stay, come",
          synonyms: ["obedience"],
          userTerms: null,
        },
      ];

      mockTaxonomyHandler.searchTaxons.mockResolvedValue(mockTaxons);

      const suggestions = await handler.suggestTagsFromText("obedience recall");

      expect(suggestions.length).toBeGreaterThan(1);
      // Higher confidence should come first
      for (let i = 0; i < suggestions.length - 1; i++) {
        expect(suggestions[i].confidence).toBeGreaterThanOrEqual(
          suggestions[i + 1].confidence,
        );
      }
    });
  });

  describe("getPopularTags", () => {
    it("should return empty array (not yet implemented)", async () => {
      const tags = await handler.getPopularTags(10);
      expect(tags).toEqual([]);
    });
  });

  describe("getUserFrequentTags", () => {
    it("should return empty array (not yet implemented)", async () => {
      const tags = await handler.getUserFrequentTags("user-123", 10);
      expect(tags).toEqual([]);
    });

    it("should handle empty userId", async () => {
      const tags = await handler.getUserFrequentTags("", 10);
      expect(tags).toEqual([]);
    });

    it("should respect limit parameter", async () => {
      const tags = await handler.getUserFrequentTags("user-123", 5);
      expect(tags).toEqual([]);
    });
  });

  describe("suggestTagsFromText edge cases", () => {
    it("should handle very short text", async () => {
      mockTaxonomyHandler.searchTaxons.mockResolvedValue([]);
      const suggestions = await handler.suggestTagsFromText("ab");
      expect(suggestions).toEqual([]);
    });

    it("should handle text with only stop words", async () => {
      mockTaxonomyHandler.searchTaxons.mockResolvedValue([]);
      const suggestions = await handler.suggestTagsFromText("the and or but");
      expect(suggestions).toEqual([]);
    });

    it("should handle text with special characters", async () => {
      const mockTaxons = [
        {
          id: "taxon-1",
          taxonId: "behavior:training:recall",
          displayName: "Recall Training",
          description: "Test",
          synonyms: null,
          userTerms: null,
        },
      ];
      mockTaxonomyHandler.searchTaxons.mockResolvedValue(mockTaxons);
      const suggestions = await handler.suggestTagsFromText("recall! @#$%");
      expect(suggestions.length).toBeGreaterThan(0);
    });

    it("should handle default options when none provided", async () => {
      mockTaxonomyHandler.searchTaxons.mockResolvedValue([]);
      const suggestions = await handler.suggestTagsFromText("test");
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });
});
