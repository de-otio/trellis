/**
 * Taxonomy Tagging E2E Tests
 *
 * Tests adding and removing taxonomy tags on entities and posts.
 */

import { afterAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Taxonomy Tagging", () => {
  const user = getShardUser(0);
  const cleanup = new TestCleanup(user.authFetch);

  afterAll(async () => {
    await cleanup.cleanAll();
  });

  describe("Read endpoints (no test data needed)", () => {
    it("get tags on non-existent entity", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await fetch(`${API_URL}/api/entities/${fakeId}/taxonomy-tags`);
      expect([200, 404]).toContain(res.status);
    });

    it("get tags on non-existent post", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await fetch(`${API_URL}/api/posts/${fakeId}/taxonomy-tags`);
      expect([200, 404]).toContain(res.status);
    });

    it("tag suggestions for non-existent post", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await fetch(`${API_URL}/api/posts/${fakeId}/tags/suggestions`);
      expect([200, 404]).toContain(res.status);
    });
  });

  describe("Entity tagging flow", () => {
    let entityId: string | null = null;
    let taxonId: string | null = null;

    it("add, get, and remove tags on entity", async () => {
      // Create entity
      const entityRes = await user.authFetch(`${API_URL}/api/entities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `__e2e_tag_entity_${Date.now()}`, type: "dog" }),
      });
      if (entityRes.status !== 201) return;
      const entityBody = await entityRes.json();
      entityId = entityBody.id;
      cleanup.track("entity", entityId!);

      // Get a taxon ID to use
      const taxRes = await fetch(`${API_URL}/api/taxonomy/dimensions`);
      if (taxRes.status !== 200) return;
      const dimensions = await taxRes.json();
      if (!Array.isArray(dimensions) || dimensions.length === 0) return;

      // Find first available taxon
      const searchRes = await fetch(`${API_URL}/api/taxonomy/taxons/search?q=a`);
      if (searchRes.status !== 200) return;
      const searchBody = await searchRes.json();
      const taxons = Array.isArray(searchBody) ? searchBody : searchBody.results || [];
      if (taxons.length === 0) return;
      taxonId = taxons[0].id || taxons[0].taxonId;

      // Add tag
      const addRes = await user.authFetch(`${API_URL}/api/entities/${entityId}/taxonomy-tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taxonIds: [taxonId] }),
      });
      expect(addRes.status).toBeLessThan(500);

      // Get tags
      const getRes = await fetch(`${API_URL}/api/entities/${entityId}/taxonomy-tags`);
      expect(getRes.status).toBeLessThan(500);

      // Remove tag
      const removeRes = await user.authFetch(`${API_URL}/api/entities/${entityId}/taxonomy-tags`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taxonIds: [taxonId] }),
      });
      expect(removeRes.status).toBeLessThan(500);
    });
  });

  describe("Post tagging flow", () => {
    it("add, get, and remove tags on post", async () => {
      // Create post
      const postRes = await user.authFetch(`${API_URL}/api/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `__e2e_tag_post_${Date.now()}` }),
      });
      if (postRes.status !== 201) return;
      const postBody = await postRes.json();
      const postId = postBody.id;
      cleanup.track("post", postId);

      // Get a taxon to tag with
      const searchRes = await fetch(`${API_URL}/api/taxonomy/taxons/search?q=a`);
      if (searchRes.status !== 200) return;
      const searchBody = await searchRes.json();
      const taxons = Array.isArray(searchBody) ? searchBody : searchBody.results || [];
      if (taxons.length === 0) return;
      const taxonId = taxons[0].id || taxons[0].taxonId;

      // Add tag
      const addRes = await user.authFetch(`${API_URL}/api/posts/${postId}/taxonomy-tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taxonIds: [taxonId] }),
      });
      expect(addRes.status).toBeLessThan(500);

      // Get tags
      const getRes = await fetch(`${API_URL}/api/posts/${postId}/taxonomy-tags`);
      expect(getRes.status).toBeLessThan(500);

      // Remove tag
      const removeRes = await user.authFetch(`${API_URL}/api/posts/${postId}/taxonomy-tags`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taxonIds: [taxonId] }),
      });
      expect(removeRes.status).toBeLessThan(500);
    });

    it("tag suggestions returns response", async () => {
      const postRes = await user.authFetch(`${API_URL}/api/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `__e2e_tag_suggest_${Date.now()}` }),
      });
      if (postRes.status !== 201) return;
      const postBody = await postRes.json();
      cleanup.track("post", postBody.id);

      const res = await fetch(`${API_URL}/api/posts/${postBody.id}/tags/suggestions`);
      expect(res.status).toBeLessThan(500);
    });
  });

  describe("Product tagging (read-only)", () => {
    it("get tags for non-existent product", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await fetch(`${API_URL}/products/${fakeId}/taxonomy-tags`);
      expect([200, 404]).toContain(res.status);
    });
  });
});
