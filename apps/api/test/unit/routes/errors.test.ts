/**
 * Unit tests: structured-error helpers.
 *
 * Every federation-surface 4xx flows through these, so the envelope shape
 * ({ error, message, remediation, field?, request_id, docs_url? }) and status
 * codes are a contract the whole API depends on. Pure functions — no mocks.
 */

import { describe, expect, it, vi } from "vitest";
import {
  structuredError,
  unauthorizedError,
  forbiddenError,
  notFoundError,
} from "../../../src/lib/routes/errors.js";

describe("structuredError", () => {
  it("builds a JSON 4xx response with the given status and body", async () => {
    const res = structuredError(422, {
      error: "INVALID",
      message: "bad",
      remediation: "fix it",
      field: "name",
    });
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("application/json");
    // Plan 034 lane C.3: every structuredError response additionally carries
    // a non-empty request_id. The original four fields are unchanged.
    expect(await res.json()).toEqual({
      error: "INVALID",
      message: "bad",
      remediation: "fix it",
      field: "name",
      request_id: expect.any(String),
    });
  });

  it("wraps via addSecurityHeaders only when a SecurityHeaders is supplied", () => {
    const addSecurityHeaders = vi.fn((r: Response) => r);
    const res = structuredError(400, { error: "X", message: "m", remediation: "r" }, {
      addSecurityHeaders,
    } as any);
    expect(addSecurityHeaders).toHaveBeenCalledOnce();
    expect(res.status).toBe(400);
  });

  // Plan 034 lane C.3 — request_id / docs_url envelope additions.
  describe("request_id and docs_url (plan 034 lane C.3)", () => {
    it("attaches a non-empty request_id with no routeMeta", async () => {
      const body = await structuredError(400, {
        error: "X",
        message: "m",
        remediation: "r",
      }).json();
      expect(typeof body.request_id).toBe("string");
      expect(body.request_id.length).toBeGreaterThan(0);
      expect(body.docs_url).toBeUndefined();
    });

    it("attaches docs_url when the route is publicSpec with an operationId", async () => {
      const body = await structuredError(
        400,
        { error: "X", message: "m", remediation: "r" },
        undefined,
        { publicSpec: true, operationId: "listTenants" },
      ).json();
      expect(body.docs_url).toBe("/openapi.json#operation/listTenants");
    });

    it("omits docs_url when publicSpec is true but operationId is absent", async () => {
      const body = await structuredError(
        400,
        { error: "X", message: "m", remediation: "r" },
        undefined,
        { publicSpec: true },
      ).json();
      expect(body.docs_url).toBeUndefined();
    });

    it("omits docs_url when operationId is present but publicSpec is not true", async () => {
      const body = await structuredError(
        400,
        { error: "X", message: "m", remediation: "r" },
        undefined,
        { operationId: "listTenants" },
      ).json();
      expect(body.docs_url).toBeUndefined();
    });

    it("two calls produce different request_ids (no accidental caching/sharing)", async () => {
      const a = await structuredError(400, { error: "X", message: "m", remediation: "r" }).json();
      const b = await structuredError(400, { error: "X", message: "m", remediation: "r" }).json();
      expect(a.request_id).not.toBe(b.request_id);
    });
  });
});

describe("error factories", () => {
  it("unauthorizedError → 401 UNAUTHORIZED with remediation", async () => {
    const res = unauthorizedError();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("UNAUTHORIZED");
    expect(body.remediation).toBeTruthy();
  });

  it("forbiddenError → 403 FORBIDDEN with default and custom message", async () => {
    expect((await forbiddenError().json()).error).toBe("FORBIDDEN");
    const custom = await forbiddenError("nope").json();
    expect(custom.message).toBe("nope");
  });

  it("notFoundError → 404 NOT_FOUND interpolating the resource name", async () => {
    expect((await notFoundError().json()).message).toBe("Resource not found.");
    expect((await notFoundError("Tenant").json()).message).toBe("Tenant not found.");
  });
});
