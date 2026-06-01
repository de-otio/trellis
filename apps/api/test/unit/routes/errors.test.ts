/**
 * Unit tests: structured-error helpers.
 *
 * Every federation-surface 4xx flows through these, so the envelope shape
 * ({ error, message, remediation, field? }) and status codes are a contract
 * the whole API depends on. Pure functions — no mocks.
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
    expect(await res.json()).toEqual({
      error: "INVALID",
      message: "bad",
      remediation: "fix it",
      field: "name",
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
