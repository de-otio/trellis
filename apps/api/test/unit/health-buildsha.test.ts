/**
 * Unit Tests: /health build provenance (buildSha)
 *
 * The container image is stamped with its own tag via the BUILD_SHA build
 * arg (consuming app's CI); /health reports it so deploy pipelines can
 * assert the running service serves the image they just built.
 */

import { afterEach, describe, expect, it } from "vitest";
import { healthRoutes } from "../../src/lib/routes/health.js";
import type { Env } from "../../src/env.js";

const healthRoute = healthRoutes.find((r) => r.path === "/health");

function makeEnv(): Env {
  // Budget check disabled so getStatus() short-circuits without I/O.
  return { OPENAI_BUDGET_ENABLED: "false" } as unknown as Env;
}

async function callHealth(): Promise<Response> {
  if (!healthRoute) throw new Error("/health route not registered");
  const request = new Request("https://api.example.com/health", {
    method: "GET",
  });
  return healthRoute.handler(request, makeEnv(), {
    url: new URL("https://api.example.com/health"),
    pathname: "/health",
    params: {},
    requestContext: undefined,
  } as never);
}

describe("/health build provenance", () => {
  const originalBuildSha = process.env.BUILD_SHA;

  afterEach(() => {
    if (originalBuildSha === undefined) {
      delete process.env.BUILD_SHA;
    } else {
      process.env.BUILD_SHA = originalBuildSha;
    }
  });

  it("reports buildSha from BUILD_SHA (CI-stamped image)", async () => {
    process.env.BUILD_SHA = "abc123def4567890";

    const response = await callHealth();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.buildSha).toBe("abc123def4567890");
  });

  it("reports buildSha null when BUILD_SHA is unset (local build)", async () => {
    delete process.env.BUILD_SHA;

    const response = await callHealth();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.buildSha).toBeNull();
  });

  it("reports buildSha null when BUILD_SHA is empty", async () => {
    process.env.BUILD_SHA = "";

    const response = await callHealth();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.buildSha).toBeNull();
  });
});
