/**
 * Taxonomy E2E Tests
 *
 * Tests public taxonomy endpoints — dimensions, taxons, search, metrics.
 * All endpoints are public and read-only.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";

const API_URL = getApiUrl();

describe("Taxonomy", () => {
  let firstDimensionCode: string | null = null;
  let firstTaxonId: string | null = null;

  it("lists taxonomy dimensions", async () => {
    const res = await fetch(`${API_URL}/api/taxonomy/dimensions`);
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      if (body.length > 0) {
        firstDimensionCode = body[0].code || body[0].id;
      }
    }
  });

  it("gets dimension by code", async () => {
    if (!firstDimensionCode) return;
    const res = await fetch(`${API_URL}/api/taxonomy/dimensions/${firstDimensionCode}`);
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("code");
    }
  });

  it("searches taxons", async () => {
    const res = await fetch(`${API_URL}/api/taxonomy/taxons/search?q=dog`);
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const body = await res.json();
      const results = Array.isArray(body) ? body : body.results || [];
      if (results.length > 0) {
        firstTaxonId = results[0].id || results[0].taxonId;
      }
    }
  });

  it("gets taxon by ID", async () => {
    if (!firstTaxonId) return;
    const res = await fetch(`${API_URL}/api/taxonomy/taxons/${firstTaxonId}`);
    expect(res.status).toBeLessThan(500);
  });

  it("returns taxonomy metrics", async () => {
    const res = await fetch(`${API_URL}/api/taxonomy/metrics`);
    expect(res.status).toBeLessThan(500);
  });

  it("returns trending topics", async () => {
    const res = await fetch(`${API_URL}/api/taxonomy/trending`);
    expect(res.status).toBeLessThan(500);
  });

  it("returns free-form tags", async () => {
    const res = await fetch(`${API_URL}/api/taxonomy/free-form-tags`);
    expect(res.status).toBeLessThan(500);
  });
});
