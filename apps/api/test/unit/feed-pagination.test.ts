import { describe, expect, it } from "vitest";

import {
  computePaginationMetadata,
  getPaginationConfig,
  validateSortField,
} from "../../src/lib/feed-pagination.js";

describe("getPaginationConfig", () => {
  it("should return maxPages=5, postsPerPage=10 for CHILD", () => {
    expect(getPaginationConfig("CHILD")).toEqual({
      maxPages: 5,
      postsPerPage: 10,
    });
  });

  it("should return maxPages=20, postsPerPage=15 for TEEN", () => {
    expect(getPaginationConfig("TEEN")).toEqual({
      maxPages: 20,
      postsPerPage: 15,
    });
  });

  it("should return maxPages=null, postsPerPage=20 for ADULT", () => {
    expect(getPaginationConfig("ADULT")).toEqual({
      maxPages: null,
      postsPerPage: 20,
    });
  });
});

describe("computePaginationMetadata", () => {
  it("should compute correct sessionPostCount", () => {
    const result = computePaginationMetadata(3, 10, null);
    expect(result.sessionPostCount).toBe(30);
  });

  it("should set hasReachedLimit=true when pageNumber equals maxPages", () => {
    const result = computePaginationMetadata(5, 10, 5);
    expect(result.hasReachedLimit).toBe(true);
  });

  it("should set hasReachedLimit=false when pageNumber is below maxPages", () => {
    const result = computePaginationMetadata(4, 10, 5);
    expect(result.hasReachedLimit).toBe(false);
  });

  it("should set hasReachedLimit=false when maxPages is null", () => {
    const result = computePaginationMetadata(100, 20, null);
    expect(result.hasReachedLimit).toBe(false);
  });

  it("should return correct pageNumber in metadata", () => {
    const result = computePaginationMetadata(7, 15, 20);
    expect(result.pageNumber).toBe(7);
    expect(result.sessionPostCount).toBe(105);
  });
});

describe("validateSortField", () => {
  it("should return true for createdAt", () => {
    expect(validateSortField("createdAt")).toBe(true);
  });

  it("should return false for sentimentCount", () => {
    expect(validateSortField("sentimentCount")).toBe(false);
  });

  it("should return false for commentCount", () => {
    expect(validateSortField("commentCount")).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(validateSortField("")).toBe(false);
  });
});
