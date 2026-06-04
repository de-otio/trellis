import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.hoisted(() => vi.fn());

vi.stubGlobal("fetch", mockFetch);

describe("check-health handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STAGE = "dev";
    process.env.DYNAMODB_TABLE = "dev-trellis";
    process.env.AWS_REGION = "us-east-1";
    process.env.API_DOMAIN = "api.dev.example.com";
  });

  it("returns statusCode, responseTimeMs, body for JSON response", async () => {
    const jsonBody = { status: "ok", uptime: 12345 };
    mockFetch.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve(jsonBody),
      text: () => Promise.resolve(JSON.stringify(jsonBody)),
    });

    const { handler } = await import(
      "../../../src/lambda/tools/check-health.js"
    );
    const result = await handler();

    expect(mockFetch).toHaveBeenCalledWith("https://api.dev.example.com/health");
    expect(result.statusCode).toBe(200);
    expect(result.responseTimeMs).toBeTypeOf("number");
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.body).toEqual(jsonBody);
  });

  it("handles non-JSON response by falling back to text", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 503,
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve("Service Unavailable"),
    });

    const { handler } = await import(
      "../../../src/lambda/tools/check-health.js"
    );
    const result = await handler();

    expect(result.statusCode).toBe(503);
    expect(result.body).toBe("Service Unavailable");
  });

  it("throws when fetch itself fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("DNS resolution failed"));

    const { handler } = await import(
      "../../../src/lambda/tools/check-health.js"
    );

    await expect(handler()).rejects.toThrow("DNS resolution failed");
  });
});
