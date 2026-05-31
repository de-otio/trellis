/**
 * Unit Tests: RelationshipSignalProvider
 *
 * Tests that the RelationshipSignalProvider interface is correctly shaped,
 * that extensions can implement it, and that computeSignal returns the
 * right value types including null (no-op) and number (0.0-1.0 signal).
 *
 * Also verifies that an extension carrying a relationshipSignalProvider
 * is structurally valid and that the provider integrates naturally with
 * a TrellisExtension.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  RelationshipSignalProvider,
  RelationshipSignalContext,
  TrellisExtension,
} from "@de-otio/trellis-extension-api";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSignalContext(
  overrides: Partial<RelationshipSignalContext> = {},
): RelationshipSignalContext {
  return {
    currentScore: 0.5,
    tier: 1,
    ...overrides,
  };
}

/** Builds a minimal TrellisExtension with an optional signal provider. */
function makeExtensionWithSignalProvider(
  provider?: RelationshipSignalProvider,
): TrellisExtension {
  return {
    id: "dog",
    terminology: { entity: "dog", entityPlural: "dogs" },
    routes: [],
    metadataSchema: z.object({}),
    relationshipSignalProvider: provider,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RelationshipSignalProvider", () => {
  describe("provider returning null", () => {
    it("handles a provider that always returns null (no-op signal)", async () => {
      const provider: RelationshipSignalProvider = {
        computeSignal: vi.fn().mockResolvedValue(null),
      };
      const result = await provider.computeSignal(
        "user-1",
        "entity-1",
        "entity",
        makeSignalContext(),
      );
      expect(result).toBeNull();
    });

    it("null result is valid — does not affect caller's score logic", async () => {
      const provider: RelationshipSignalProvider = {
        computeSignal: async () => null,
      };
      const result = await provider.computeSignal(
        "user-1",
        "entity-2",
        "user",
        makeSignalContext({ currentScore: 0.8 }),
      );
      // Callers check for null before blending — this must be explicitly null
      expect(result).toBeNull();
    });
  });

  describe("provider returning a numeric signal", () => {
    it("accepts a small positive signal (0.05)", async () => {
      const provider: RelationshipSignalProvider = {
        computeSignal: vi.fn().mockResolvedValue(0.05),
      };
      const result = await provider.computeSignal(
        "user-1",
        "entity-1",
        "entity",
        makeSignalContext(),
      );
      expect(result).toBe(0.05);
    });

    it("accepts a mid-range signal (0.5)", async () => {
      const provider: RelationshipSignalProvider = {
        computeSignal: async () => 0.5,
      };
      const result = await provider.computeSignal(
        "user-1",
        "entity-1",
        "entity",
        makeSignalContext({ currentScore: 0.3 }),
      );
      expect(result).toBe(0.5);
    });

    it("accepts max signal (1.0)", async () => {
      const provider: RelationshipSignalProvider = {
        computeSignal: async () => 1.0,
      };
      const result = await provider.computeSignal(
        "user-1",
        "entity-1",
        "entity",
        makeSignalContext({ tier: 0 }),
      );
      expect(result).toBe(1.0);
    });

    it("receives and can use entityMetadata from context", async () => {
      const receivedContext: RelationshipSignalContext[] = [];
      const provider: RelationshipSignalProvider = {
        computeSignal: async (_userId, _targetId, _targetType, ctx) => {
          receivedContext.push(ctx);
          const breed = ctx.entityMetadata?.breed as string | undefined;
          return breed === "labrador" ? 0.8 : 0.1;
        },
      };

      const ctx = makeSignalContext({
        entityMetadata: { breed: "labrador" },
      });
      const result = await provider.computeSignal(
        "user-1",
        "dog-1",
        "entity",
        ctx,
      );
      expect(result).toBe(0.8);
      expect(receivedContext[0].entityMetadata?.breed).toBe("labrador");
    });
  });

  describe("integration with TrellisExtension", () => {
    it("extension with relationshipSignalProvider has callable computeSignal", async () => {
      const mockComputeSignal = vi.fn().mockResolvedValue(0.05);
      const ext = makeExtensionWithSignalProvider({
        computeSignal: mockComputeSignal,
      });

      expect(ext.relationshipSignalProvider).toBeDefined();
      const result = await ext.relationshipSignalProvider!.computeSignal(
        "user-abc",
        "dog-xyz",
        "entity",
        makeSignalContext({ currentScore: 0.4, tier: 2 }),
      );
      expect(result).toBe(0.05);
      expect(mockComputeSignal).toHaveBeenCalledOnce();
      expect(mockComputeSignal).toHaveBeenCalledWith(
        "user-abc",
        "dog-xyz",
        "entity",
        expect.objectContaining({ currentScore: 0.4, tier: 2 }),
      );
    });

    it("extension without a signal provider has undefined relationshipSignalProvider", () => {
      const ext = makeExtensionWithSignalProvider(undefined);
      expect(ext.relationshipSignalProvider).toBeUndefined();
    });

    it("provider is called with correct targetType discriminant (user vs entity)", async () => {
      const calls: Array<{ targetType: string }> = [];
      const provider: RelationshipSignalProvider = {
        computeSignal: async (_u, _t, targetType, _ctx) => {
          calls.push({ targetType });
          return targetType === "entity" ? 0.2 : null;
        },
      };
      const ext = makeExtensionWithSignalProvider(provider);

      const entityResult = await ext.relationshipSignalProvider!.computeSignal(
        "user-1",
        "entity-1",
        "entity",
        makeSignalContext(),
      );
      const userResult = await ext.relationshipSignalProvider!.computeSignal(
        "user-1",
        "user-2",
        "user",
        makeSignalContext(),
      );

      expect(entityResult).toBe(0.2);
      expect(userResult).toBeNull();
      expect(calls).toHaveLength(2);
      expect(calls[0].targetType).toBe("entity");
      expect(calls[1].targetType).toBe("user");
    });
  });
});
