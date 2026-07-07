import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockIsEnabled, state } = vi.hoisted(() => ({
  mockIsEnabled: vi.fn(),
  state: { throwOnConstruct: false },
}));

vi.mock("../../src/db.js", () => ({ createPrisma: () => ({}) }));
vi.mock("../../src/lib/feature-toggle-service.js", () => ({
  FeatureToggleService: class {
    constructor() {
      if (state.throwOnConstruct) throw new Error("boom");
    }
    isEnabled = mockIsEnabled;
  },
}));

import { featureToggleMiddleware } from "../../src/lib/feature-gate-middleware.js";

const ctx = { request: new Request("https://x.example/api/collections"), env: {} } as any;

describe("featureToggleMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.throwOnConstruct = false;
  });

  it("calls next() when the toggle is enabled", async () => {
    mockIsEnabled.mockResolvedValue(true);
    const next = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await featureToggleMiddleware("collections_enabled")(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(mockIsEnabled).toHaveBeenCalledWith("collections_enabled");
  });

  it("returns 404 (not 403) when the toggle is disabled, without calling next()", async () => {
    mockIsEnabled.mockResolvedValue(false);
    const next = vi.fn();
    const res = await featureToggleMiddleware("collections_enabled")(ctx, next);
    expect(res.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed (404) when the toggle cannot be resolved", async () => {
    state.throwOnConstruct = true;
    const next = vi.fn();
    const res = await featureToggleMiddleware("collections_enabled")(ctx, next);
    expect(res.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });
});
