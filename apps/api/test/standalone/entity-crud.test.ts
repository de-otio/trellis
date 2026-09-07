/**
 * Standalone — entity CRUD against the dummy extension.
 *
 * Proves the full request path: a registered extension's `metadataSchema`
 * validates Entity.metadata on create, and the entity round-trips through
 * Postgres. This is the core "is the extension contract wired end-to-end?"
 * check, runnable with no AWS.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedFetch,
  createTestUserWithSession,
  getCsrfToken,
} from "../utils/test-auth.js";
import { getApiUrl } from "../utils/test-config.js";

const API_URL = getApiUrl();

/** POST helper that attaches a fresh CSRF token + the re-encrypted session. */
async function postJson(
  sessionToken: string,
  path: string,
  payload: unknown,
): Promise<{ res: Response; sessionToken: string }> {
  const { token, updatedSessionToken } = await getCsrfToken(API_URL, sessionToken);
  const res = await authenticatedFetch(`${API_URL}${path}`, updatedSessionToken, {
    method: "POST",
    headers: { "content-type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify(payload),
  });
  return { res, sessionToken: updatedSessionToken };
}

describe("standalone: entity CRUD (example extension)", () => {
  let sessionToken: string;

  beforeAll(async () => {
    const { sessionToken: token } = await createTestUserWithSession();
    sessionToken = token;
  });

  // The metadataSchema VALIDATION contract is proven by the 400 cases below:
  // `getExtension(entityType).metadataSchema.safeParse(...)` runs before the DB
  // write, so a registered extension's schema gating is fully exercised here.
  //
  // This happy-path create was skipped for as long as
  // `EntityHandler.createEntityProfile` predated the v0.7 tenancy migration:
  // it sent an `ownerId` scalar the model no longer has and omitted the now
  // required `tenantId`, so every create 500'd on `Argument 'tenant' is
  // missing`. The handler now resolves a tenant (ambient → the creator's
  // personal tenant) and writes the ownership row; this is the end-to-end
  // proof of that.
  it("creates an example entity with valid metadata (201)", async () => {
    const { res } = await postJson(sessionToken, "/api/entities", {
      name: "Test Widget",
      entityType: "example",
      metadata: { color: "blue", size: "m" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entityType).toBe("example");
    expect(body.name).toBe("Test Widget");
    expect(body.metadata).toMatchObject({ color: "blue", size: "m" });
  });

  it("rejects metadata that violates the extension schema (400)", async () => {
    const { res } = await postJson(sessionToken, "/api/entities", {
      name: "Bad Widget",
      entityType: "example",
      // size must be one of s|m|l — "xl" is invalid.
      metadata: { color: "red", size: "xl" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_METADATA");
  });

  it("rejects an unknown entityType (400)", async () => {
    const { res } = await postJson(sessionToken, "/api/entities", {
      name: "Orphan",
      entityType: "not-registered",
      metadata: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("UNKNOWN_ENTITY_TYPE");
  });

  it("create then read-back returns the entity", async () => {
    const { res: createRes } = await postJson(sessionToken, "/api/entities", {
      name: "Readable Widget",
      entityType: "example",
      metadata: { color: "green", size: "l" },
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const getRes = await authenticatedFetch(
      `${API_URL}/api/entities/${created.id}`,
      sessionToken,
    );
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("Readable Widget");
  });
});
