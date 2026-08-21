import { describe, expect, it, vi } from "vitest";

import {
  ScalewayVisionModerationProvider,
  type ScalewayVisionModerationConfig,
} from "../../../src/lib/media/scaleway-vision-provider.js";
import {
  isModerationProviderError,
  type ImageRef,
  type ModerationVerdict,
} from "../../../src/lib/media/moderation-provider.js";
import type { MediaBytesAccess } from "../../../src/lib/media/media-bytes-access.js";

// Opaque category tokens — the real vocabulary is operator config and never
// appears in core or in these tests. `cat_a` etc. stand in for whatever tokens
// a deployment supplies.
const CATEGORIES = ["cat_a", "cat_b", "cat_c"] as const;
const MODEL = "test-vision-model-1";
const REF: ImageRef = { bucket: "example-media-bucket", key: "cas/tenant/hash" };

// A minimal JPEG magic-byte header so the mime sniff picks image/jpeg.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function bytesAccess(payload: Buffer = JPEG_BYTES): MediaBytesAccess {
  return { maxBytes: 1_000_000, read: async () => payload };
}

/** A fetch double returning one canned chat-completion body with `content`. */
function fetchReturning(
  content: string,
  overrides: { status?: number; model?: string; rawBody?: unknown } = {},
): { impl: typeof fetch; calls: () => number; lastBody: () => unknown } {
  let count = 0;
  let lastBody: unknown;
  const impl = (async (_url: string, init?: RequestInit) => {
    count += 1;
    lastBody = init?.body ? JSON.parse(init.body as string) : undefined;
    const body =
      overrides.rawBody ??
      ({ model: overrides.model ?? MODEL, choices: [{ message: { content } }] } as unknown);
    return {
      ok: (overrides.status ?? 200) < 400,
      status: overrides.status ?? 200,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls: () => count, lastBody: () => lastBody };
}

function scores(obj: Record<string, number>): string {
  return JSON.stringify({ categories: obj });
}

function makeProvider(
  over: Partial<ScalewayVisionModerationConfig> = {},
  fetchImpl?: typeof fetch,
): ScalewayVisionModerationProvider {
  return new ScalewayVisionModerationProvider({
    baseUrl: "https://api.example.test/proj/v1",
    model: MODEL,
    apiKey: "secret-key-value",
    categories: [...CATEGORIES],
    systemPrompt: "operator-supplied taxonomy prompt",
    bytes: bytesAccess(),
    fetchImpl: fetchImpl ?? fetchReturning(scores({ cat_a: 0, cat_b: 0, cat_c: 0 })).impl,
    ...over,
  });
}

describe("ScalewayVisionModerationProvider — construction", () => {
  const base: ScalewayVisionModerationConfig = {
    baseUrl: "https://api.example.test/proj/v1",
    model: MODEL,
    apiKey: "k",
    categories: [...CATEGORIES],
    systemPrompt: "p",
    bytes: bytesAccess(),
  };

  it("rejects a missing key / model / baseUrl", () => {
    expect(() => new ScalewayVisionModerationProvider({ ...base, apiKey: "" })).toThrow(
      /baseUrl, model and apiKey/,
    );
    expect(() => new ScalewayVisionModerationProvider({ ...base, model: "" })).toThrow();
    expect(() => new ScalewayVisionModerationProvider({ ...base, baseUrl: "" })).toThrow();
  });

  it("rejects an empty category set and a missing prompt", () => {
    expect(() => new ScalewayVisionModerationProvider({ ...base, categories: [] })).toThrow(
      /at least one category/,
    );
    expect(() => new ScalewayVisionModerationProvider({ ...base, systemPrompt: "" })).toThrow(
      /systemPrompt/,
    );
  });

  it("reports the configured provider name, defaulting to scaleway-vision", () => {
    expect(makeProvider().name).toBe("scaleway-vision");
    expect(makeProvider({ providerName: "custom-vision" }).name).toBe("custom-vision");
  });
});

describe("ScalewayVisionModerationProvider — request shape", () => {
  it("posts strict json_schema, temperature 0, the model, and a data URI, with a bearer key", async () => {
    const fx = fetchReturning(scores({ cat_a: 0, cat_b: 0, cat_c: 0 }));
    const spy = vi.fn(fx.impl);
    await makeProvider({}, spy as unknown as typeof fetch).moderateImage(REF);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/proj/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key-value");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(MODEL);
    expect(body.temperature).toBe(0);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.properties.categories.required).toEqual([
      ...CATEGORIES,
    ]);
    const userContent = body.messages[1].content;
    expect(userContent[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("sniffs PNG magic bytes into the data URI mime", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fx = fetchReturning(scores({ cat_a: 0, cat_b: 0, cat_c: 0 }));
    const spy = vi.fn(fx.impl);
    await makeProvider({ bytes: bytesAccess(png) }, spy as unknown as typeof fetch).moderateImage(
      REF,
    );
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[1].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
  });
});

describe("ScalewayVisionModerationProvider — verdict mapping", () => {
  it("maps every configured category to a label and echoes the model as modelVersion", async () => {
    const provider = makeProvider(
      {},
      fetchReturning(scores({ cat_a: 0.1, cat_b: 0.9, cat_c: 0.4 }), { model: MODEL }).impl,
    );
    const verdict = await provider.moderateImage(REF);
    expect(verdict.provider).toBe("scaleway-vision");
    expect(verdict.modelVersion).toBe(MODEL);
    expect(verdict.labels).toEqual([
      { category: "cat_a", confidence: 0.1 },
      { category: "cat_b", confidence: 0.9 },
      { category: "cat_c", confidence: 0.4 },
    ]);
  });

  it("baseline decision is approved with no floors, letting a label policy do the thresholding", async () => {
    const provider = makeProvider(
      {},
      fetchReturning(scores({ cat_a: 0.99, cat_b: 0, cat_c: 0 })).impl,
    );
    expect((await provider.moderateImage(REF)).decision).toBe("approved");
  });

  it("applies operator floors to the highest confidence", async () => {
    // review at 0.5, quarantine at 0.8
    const cfg = { reviewFloor: 0.5, quarantineFloor: 0.8 };
    const rows: Array<[Record<string, number>, ModerationVerdict["decision"]]> = [
      [{ cat_a: 0.2, cat_b: 0.1, cat_c: 0.0 }, "approved"],
      [{ cat_a: 0.6, cat_b: 0.1, cat_c: 0.0 }, "review"],
      [{ cat_a: 0.9, cat_b: 0.1, cat_c: 0.0 }, "quarantine"],
      [{ cat_a: 0.5, cat_b: 0.0, cat_c: 0.0 }, "review"], // boundary is inclusive
      [{ cat_a: 0.8, cat_b: 0.0, cat_c: 0.0 }, "quarantine"],
    ];
    for (const [obj, expected] of rows) {
      const provider = makeProvider(cfg, fetchReturning(scores(obj)).impl);
      expect((await provider.moderateImage(REF)).decision, JSON.stringify(obj)).toBe(expected);
    }
  });
});

describe("ScalewayVisionModerationProvider — fail closed", () => {
  const malformed: Array<[string, unknown]> = [
    ["no choices", { model: MODEL }],
    ["null content", { choices: [{ message: { content: null } }] }],
    ["not JSON", { choices: [{ message: { content: "sorry, I can't do that" } }] }],
    ["missing categories key", { choices: [{ message: { content: JSON.stringify({ x: 1 }) } }] }],
    [
      "a category absent",
      { choices: [{ message: { content: JSON.stringify({ categories: { cat_a: 0.1, cat_b: 0.2 } }) } }] },
    ],
    [
      "a confidence out of range",
      {
        choices: [
          { message: { content: JSON.stringify({ categories: { cat_a: 1.4, cat_b: 0, cat_c: 0 } }) } },
        ],
      },
    ],
    [
      "a confidence not a number",
      {
        choices: [
          {
            message: {
              content: JSON.stringify({ categories: { cat_a: "high", cat_b: 0, cat_c: 0 } }),
            },
          },
        ],
      },
    ],
  ];

  for (const [name, rawBody] of malformed) {
    it(`returns review (never approved) when the model answer is unusable: ${name}`, async () => {
      const provider = makeProvider(
        {},
        fetchReturning("", { rawBody }).impl,
      );
      const verdict = await provider.moderateImage(REF);
      expect(verdict.decision).toBe("review");
      expect(verdict.labels).toEqual([]);
      expect(verdict.provider).toBe("scaleway-vision");
    });
  }
});

describe("ScalewayVisionModerationProvider — error classification", () => {
  async function moderateExpectingThrow(fetchImpl: typeof fetch) {
    try {
      await makeProvider({}, fetchImpl).moderateImage(REF);
      throw new Error("expected a throw");
    } catch (err) {
      expect(isModerationProviderError(err)).toBe(true);
      return err as { retryable: boolean; unknownCause: boolean };
    }
  }

  it("401/403 → permanent + alerting (unknownCause)", async () => {
    for (const status of [401, 403]) {
      const err = await moderateExpectingThrow(fetchReturning("", { status }).impl);
      expect(err.retryable).toBe(false);
      expect(err.unknownCause).toBe(true);
    }
  });

  it("429 and 5xx → retryable", async () => {
    for (const status of [429, 500, 503]) {
      const err = await moderateExpectingThrow(fetchReturning("", { status }).impl);
      expect(err.retryable).toBe(true);
    }
  });

  it("other 4xx (e.g. 400) → permanent, not alerting", async () => {
    const err = await moderateExpectingThrow(fetchReturning("", { status: 400 }).impl);
    expect(err.retryable).toBe(false);
    expect(err.unknownCause).toBe(false);
  });

  it("a network throw → retryable + alerting", async () => {
    const boom = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const err = await moderateExpectingThrow(boom);
    expect(err.retryable).toBe(true);
    expect(err.unknownCause).toBe(true);
  });

  it("an oversize read → permanent, alerting", async () => {
    const bytes: MediaBytesAccess = {
      maxBytes: 10,
      read: async () => {
        const e = new Error("too large");
        e.name = "MediaBytesTooLargeError";
        throw e;
      },
    };
    try {
      await makeProvider({ bytes }).moderateImage(REF);
      throw new Error("expected a throw");
    } catch (err) {
      expect(isModerationProviderError(err)).toBe(true);
      expect((err as { retryable: boolean }).retryable).toBe(false);
    }
  });
});

describe("ScalewayVisionModerationProvider — signal + video", () => {
  it("throws retryable when the signal is already aborted before the read", async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await makeProvider().moderateImage(REF, { signal: controller.signal });
      throw new Error("expected a throw");
    } catch (err) {
      expect(isModerationProviderError(err)).toBe(true);
      expect((err as { retryable: boolean }).retryable).toBe(true);
    }
  });

  it("forwards the abort signal to fetch", async () => {
    const spy = vi.fn(fetchReturning(scores({ cat_a: 0, cat_b: 0, cat_c: 0 })).impl);
    const controller = new AbortController();
    await makeProvider({}, spy as unknown as typeof fetch).moderateImage(REF, {
      signal: controller.signal,
    });
    expect((spy.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  it("video methods throw a permanent error — this provider is image-only", async () => {
    const provider = makeProvider();
    await expect(provider.startVideoModeration(REF)).rejects.toThrow(/image-only/);
    await expect(provider.getVideoModeration("job-1")).rejects.toThrow(/image-only/);
  });
});
