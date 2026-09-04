/**
 * Unit Tests: DataRouter.createPost — authorOrgRootCategoryCode denormalization (T2).
 *
 * Proves the feed-declutter write-path behavior:
 *   - a tenant WITH a classification stamps the resolved ROOT category code
 *     onto the created post (via resolveRootCategoryCode over the tree);
 *   - a tenant with NO classification leaves the column unset (null);
 *   - the value flows ONLY through the sanitized field allowlist
 *     (sanitizedPostData → createData) — a caller-supplied
 *     `authorOrgRootCategoryCode` on postData is NEVER copied through (allowlist
 *     guarantee; this test fails if the field is added by spreading postData);
 *   - a lookup failure is non-fatal: the post is still created with a null code.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataRouterEnv } from "../../src/lib/data-router.js";
import { DataRouter } from "../../src/lib/data-router.js";

// Captured create-data for the post row, plus configurable lookup results.
let capturedCreateData: any;
let classificationResult: { categoryId: string } | null;
let categoriesResult: Array<{ id: string; code: string; parentCategoryId: string | null }>;
let classificationShouldThrow: boolean;

function createMockDatabase() {
  const mockPostCreate = vi.fn(async (data: any) => {
    capturedCreateData = data.data;
    return {
      id: "post-123",
      authorId: data.data.authorId,
      text: data.data.text,
      dataRegion: data.data.dataRegion,
      tenantId: data.data.tenantId,
    };
  });

  return {
    tenantClassification: {
      findUnique: vi.fn(async () => {
        if (classificationShouldThrow) throw new Error("db down");
        return classificationResult;
      }),
    },
    platformCategory: {
      findMany: vi.fn(async () => categoriesResult),
    },
    post: { create: mockPostCreate },
    $transaction: vi.fn(async (callback: any) => {
      const tx = {
        post: { create: mockPostCreate },
        postEntity: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        postMedia: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        mediaFile: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        // Outbox writer (plan 034 lane E) — `post.published` is emitted inside
        // this same transaction, so the tx double needs the delegate.
        domainEvent: { create: vi.fn().mockResolvedValue({ id: "de_1" }) },
        entity: { findMany: vi.fn().mockResolvedValue([]) },
      };
      return await callback(tx);
    }),
  };
}

vi.mock("../../src/db", () => ({
  createPrismaForRegion: vi.fn(() => createMockDatabase()),
}));

vi.mock("../../src/lib/region-detection", () => {
  const mockIsValidRegion = vi.fn((region: string) => ["US", "EU", "CN"].includes(region));
  return {
    isValidRegion: mockIsValidRegion,
    RegionDetector: class {
      isValidRegion = mockIsValidRegion;
    },
  };
});

const mockLogUserAction = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/lib/audit-composer", () => {
  class MockAuditLogger {
    logUserAction = mockLogUserAction;
    logDataAccess = vi.fn().mockResolvedValue(undefined);
    withRequestId() {
      return new MockAuditLogger();
    }
  }
  return { TrellisAuditLogger: MockAuditLogger };
});

vi.mock("../../src/lib/ip-scrubber", () => ({
  getIPAddress: vi.fn(() => "127.0.0.1"),
}));

const env: DataRouterEnv = {
  DATABASE_URL: "postgres://test",
  DEFAULT_REGION: "US",
} as DataRouterEnv;

function basePostData(overrides: Record<string, unknown> = {}) {
  return {
    authorId: "user-123",
    text: "Test post",
    radius: "SHOUT",
    tenantId: "tenant-x",
    ...overrides,
  };
}

// A small tree: business (root) → business:agency (leaf); nonprofit (root).
const TREE = [
  { id: "cat-business", code: "business", parentCategoryId: null },
  { id: "cat-agency", code: "business:agency", parentCategoryId: "cat-business" },
  { id: "cat-nonprofit", code: "nonprofit", parentCategoryId: null },
];

describe("DataRouter.createPost — authorOrgRootCategoryCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCreateData = undefined;
    classificationResult = null;
    categoriesResult = TREE;
    classificationShouldThrow = false;
  });

  it("stamps the ROOT category code when the tenant is classified on a leaf node", async () => {
    classificationResult = { categoryId: "cat-agency" }; // leaf under business

    const post = await DataRouter.createPost(basePostData(), "US", env);

    expect(post.id).toBe("post-123");
    // Root of business:agency is "business".
    expect(capturedCreateData.authorOrgRootCategoryCode).toBe("business");
  });

  it("stamps the code directly when the tenant is classified on a root node", async () => {
    classificationResult = { categoryId: "cat-nonprofit" };

    await DataRouter.createPost(basePostData(), "US", env);

    expect(capturedCreateData.authorOrgRootCategoryCode).toBe("nonprofit");
  });

  it("leaves the column unset when the tenant has NO classification", async () => {
    classificationResult = null;

    await DataRouter.createPost(basePostData(), "US", env);

    expect("authorOrgRootCategoryCode" in capturedCreateData).toBe(false);
  });

  it("leaves the column unset when the categoryId is dangling (resolves to null)", async () => {
    classificationResult = { categoryId: "cat-ghost" }; // not present in the tree

    await DataRouter.createPost(basePostData(), "US", env);

    expect("authorOrgRootCategoryCode" in capturedCreateData).toBe(false);
  });

  it("ignores a caller-supplied authorOrgRootCategoryCode on postData (allowlist guarantee)", async () => {
    // No classification, but a malicious/confused caller sets the field directly.
    classificationResult = null;

    await DataRouter.createPost(
      basePostData({ authorOrgRootCategoryCode: "government" }),
      "US",
      env,
    );

    // The allowlist never copies raw postData fields — so the injected value is dropped.
    expect(capturedCreateData.authorOrgRootCategoryCode).toBeUndefined();
  });

  it("uses the RESOLVED value, not a caller-supplied one, when the tenant is classified", async () => {
    classificationResult = { categoryId: "cat-agency" };

    await DataRouter.createPost(
      basePostData({ authorOrgRootCategoryCode: "government" }),
      "US",
      env,
    );

    expect(capturedCreateData.authorOrgRootCategoryCode).toBe("business");
  });

  it("does not fail the post write when the classification lookup throws (best-effort)", async () => {
    classificationShouldThrow = true;

    const post = await DataRouter.createPost(basePostData(), "US", env);

    expect(post.id).toBe("post-123");
    expect("authorOrgRootCategoryCode" in capturedCreateData).toBe(false);
  });
});
