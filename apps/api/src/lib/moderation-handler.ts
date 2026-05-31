import type { KVNamespace, R2Bucket, CloudflareQueue } from "../types/cloudflare-compat.js";
/**
 * Moderation Handler
 *
 * Handles text content moderation using OpenAI Moderation API.
 * Caches moderation results in KV to reduce API calls.
 * Respects OpenAI budget limits — skips moderation when budget is exceeded.
 */


import { getLogger, Logger } from "./logger.js";
import { OpenAiBudget, type OpenAiBudgetConfig } from "./openai-budget.js";
import { CostAccumulator } from "./cost-accumulator.js";

export interface Env {
  OPENAI_API_KEY?: string; // OpenAI API key for moderation API (text moderation)
  MODERATION_CACHE_KV?: KVNamespace;
  FEED_CACHE_KV?: KVNamespace; // Fallback to feed cache KV
}

export interface ModerationResult {
  approved: boolean;
  score?: number; // Max category score for backwards compatibility
  details?: {
    categories: {
      hate: boolean;
      hate_threatening: boolean;
      harassment: boolean;
      harassment_threatening: boolean;
      self_harm: boolean;
      self_harm_intent: boolean;
      self_harm_instructions: boolean;
      sexual: boolean;
      sexual_minors: boolean;
      violence: boolean;
      violence_graphic: boolean;
    };
    categoryScores: {
      [key: string]: number;
    };
  };
  error?: string;
  /** True when moderation was skipped due to budget. Caller should flag content for deferred review. */
  budgetExceeded?: boolean;
}

export class ModerationHandler {
  private readonly OPENAI_API_URL = "https://api.openai.com/v1/moderations";

  /**
   * Moderate text content using OpenAI Moderation API
   */
  async moderateText(text: string, env: Env): Promise<ModerationResult> {
    // Check OpenAI budget before making API call
    const budgetConfig: OpenAiBudgetConfig = {
      enabled: (env as any).OPENAI_BUDGET_ENABLED !== "false",
      maxRequestsPerHour: parseInt((env as any).OPENAI_BUDGET_HOURLY_MAX || "500", 10),
      maxRequestsPerDay: parseInt((env as any).OPENAI_BUDGET_DAILY_MAX || "5000", 10),
    };
    const budget = new OpenAiBudget(budgetConfig);
    if (!await budget.tryConsume()) {
      getLogger().warn("[Moderation] OpenAI budget exceeded, skipping moderation");
      return { approved: true, budgetExceeded: true };
    }

    // OPTIMIZATION: Check cache first with timeout to avoid slow KV reads
    const cacheKey = this.getCacheKey(text);
    const CACHE_TIMEOUT_MS = 500; // 0.5 seconds max for cache lookup
    let cached: ModerationResult | null = null;
    try {
      const cachePromise = this.getCachedResult(cacheKey, env);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Cache timeout")), CACHE_TIMEOUT_MS);
      });
      cached = await Promise.race([cachePromise, timeoutPromise]);
    } catch (error) {
      // If cache lookup times out or fails, continue without cache
      getLogger().debug(
        "[ModerationHandler] Cache lookup timeout/failed, continuing without cache",
      );
    }

    if (cached) {
      return cached;
    }

    const apiKey = env.OPENAI_API_KEY;

    // If no API key, skip moderation (for development/testing)
    if (!apiKey) {
      getLogger().warn(
        "OPENAI_API_KEY not set, skipping moderation",
      );
      return { approved: true };
    }

    try {
      // OPTIMIZATION: Add timeout to OpenAI API call to fail fast
      // If API is slow, don't block post creation
      const MODERATION_TIMEOUT_MS = 2000; // 2 seconds max for moderation
      const fetchPromise = fetch(this.OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: "text-moderation-latest",
        }),
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Moderation API timeout"));
        }, MODERATION_TIMEOUT_MS);
      });

      const response = await Promise.race([fetchPromise, timeoutPromise]);

      if (!response.ok) {
        const errorText = await response.text();
        getLogger().error(
          "OpenAI Moderation API error:",
          errorText,
        );
        // On API error, approve content (fail open for availability)
        return { approved: true, error: "Moderation service unavailable" };
      }

      const data = (await response.json()) as {
        results: Array<{
          flagged: boolean;
          categories: {
            hate: boolean;
            "hate/threatening": boolean;
            harassment: boolean;
            "harassment/threatening": boolean;
            "self-harm": boolean;
            "self-harm/intent": boolean;
            "self-harm/instructions": boolean;
            sexual: boolean;
            "sexual/minors": boolean;
            violence: boolean;
            "violence/graphic": boolean;
          };
          category_scores: {
            hate: number;
            "hate/threatening": number;
            harassment: number;
            "harassment/threatening": number;
            "self-harm": number;
            "self-harm/intent": number;
            "self-harm/instructions": number;
            sexual: number;
            "sexual/minors": number;
            violence: number;
            "violence/graphic": number;
          };
        }>;
      };

      const result = data.results[0];

      // Simple flag-based approval (no complex threshold logic)
      const approved = !result.flagged;

      // Convert category names to snake_case for consistency
      const categories = {
        hate: result.categories.hate,
        hate_threatening: result.categories["hate/threatening"],
        harassment: result.categories.harassment,
        harassment_threatening: result.categories["harassment/threatening"],
        self_harm: result.categories["self-harm"],
        self_harm_intent: result.categories["self-harm/intent"],
        self_harm_instructions: result.categories["self-harm/instructions"],
        sexual: result.categories.sexual,
        sexual_minors: result.categories["sexual/minors"],
        violence: result.categories.violence,
        violence_graphic: result.categories["violence/graphic"],
      };

      const categoryScores: { [key: string]: number } = {
        hate: result.category_scores.hate,
        hate_threatening: result.category_scores["hate/threatening"],
        harassment: result.category_scores.harassment,
        harassment_threatening:
          result.category_scores["harassment/threatening"],
        self_harm: result.category_scores["self-harm"],
        self_harm_intent: result.category_scores["self-harm/intent"],
        self_harm_instructions:
          result.category_scores["self-harm/instructions"],
        sexual: result.category_scores.sexual,
        sexual_minors: result.category_scores["sexual/minors"],
        violence: result.category_scores.violence,
        violence_graphic: result.category_scores["violence/graphic"],
      };

      // Calculate max score for backwards compatibility
      const maxScore = Math.max(...Object.values(categoryScores));

      const moderationResult: ModerationResult = {
        approved,
        score: maxScore,
        details: {
          categories,
          categoryScores,
        },
      };

      // Record cost event (in-memory, zero I/O)
      CostAccumulator.getInstance().record({ service: "openai", operation: "moderation", units: 1 });

      // Cache result (24 hour TTL) - fire and forget to avoid blocking
      // Don't await - if caching is slow, don't block the response
      this.cacheResult(cacheKey, moderationResult, env).catch((error) => {
        getLogger().debug(
          "[ModerationHandler] Cache write failed (non-blocking):",
          error,
        );
      });

      return moderationResult;
    } catch (error) {
      getLogger().error("Moderation error:", error);
      // Fail open - approve content if moderation fails
      return { approved: true, error: "Moderation service error" };
    }
  }

  /**
   * Get cache key for text content
   */
  private getCacheKey(text: string): string {
    // Use a hash of the text as cache key
    // In production, use a proper hash function
    const hash = this.simpleHash(text);
    return `moderation:${hash}`;
  }

  /**
   * Simple hash function for cache keys
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Get cached moderation result
   */
  private async getCachedResult(
    cacheKey: string,
    env: Env,
  ): Promise<ModerationResult | null> {
    const kv = env.MODERATION_CACHE_KV || env.FEED_CACHE_KV;
    if (!kv) return null;

    try {
      const cached = await kv.get(cacheKey, "json");
      return cached as ModerationResult | null;
    } catch (error) {
      getLogger().error("Cache read error:", error);
      return null;
    }
  }

  /**
   * Cache moderation result
   */
  private async cacheResult(
    cacheKey: string,
    result: ModerationResult,
    env: Env,
  ): Promise<void> {
    const kv = env.MODERATION_CACHE_KV || env.FEED_CACHE_KV;
    if (!kv) return;

    try {
      // Cache for 24 hours
      await kv.put(cacheKey, JSON.stringify(result), {
        expirationTtl: 24 * 60 * 60,
      });
    } catch (error) {
      getLogger().error("Cache write error:", error);
      // Non-fatal - continue without caching
    }
  }
}
