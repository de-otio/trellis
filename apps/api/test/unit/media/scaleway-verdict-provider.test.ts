import { describe, expect, it, vi } from "vitest";

import {
  ScalewayVerdictModerationProvider,
  type ScalewayVerdictModerationConfig,
} from "../../../src/lib/media/scaleway-verdict-provider.js";
import {
  isModerationProviderError,
  type ImageRef,
} from "../../../src/lib/media/moderation-provider.js";
import type { MediaBytesAccess } from "../../../src/lib/media/media-bytes-access.js";

const MODEL = "test-vision-model-1";
const REF: ImageRef = { bucket: "example-media-bucket", key: "cas/tenant/hash" };
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function bytesAccess(payload: Buffer = JPEG_BYTES): MediaBytesAccess {
  return { maxBytes: 1_000_000, read: async () => payload };
}

function config(
  overrides: Partial<ScalewayVerdictModerationConfig> = {},
): ScalewayVerdictModerationConfig {
  return {
    baseUrl: "https://api.example.test/v1",
    model: MODEL,
    apiKey: "test-key",
    systemPrompt: "Decide pass or block under the policy.",
    bytes: bytesAccess(),
    ...overrides,
  };
}

/** A fetch double that returns one chat-completions envelope with `content`. */
function fetchReturning(content: string, overrides: Record<string, unknown> = {}): typeof fetch {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({ model: MODEL, choices: [{ message: { content } }], ...overrides }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  ) as unknown as typeof fetch;
}

function verdictContent(verdict: string, reason = "because"): string {
  return JSON.stringify({ verdict, reason });
}

describe("ScalewayVerdictModerationProvider — construction", () => {
  it("requires baseUrl, model, apiKey", () => {
    expect(() => new ScalewayVerdictModerationProvider(config({ baseUrl: "" }))).toThrow();
    expect(() => new ScalewayVerdictModerationProvider(config({ model: "" }))).toThrow();
    expect(() => new ScalewayVerdictModerationProvider(config({ apiKey: "" }))).toThrow();
  });
  it("requires a systemPrompt (operator policy)", () => {
    expect(() => new ScalewayVerdictModerationProvider(config({ systemPrompt: "" }))).toThrow();
  });
});

describe("ScalewayVerdictModerationProvider — request shape", () => {
  it("requests the strict verdict json_schema at temperature 0 with bearer auth + data URI", async () => {
    const fetchImpl = fetchReturning(verdictContent("pass"));
    await new ScalewayVerdictModerationProvider(config({ fetchImpl })).moderateImage(REF);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.example.test/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe(MODEL);
    expect(body.temperature).toBe(0);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.properties.verdict.enum).toEqual([
      "pass",
      "block",
    ]);
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer test-key" });
    expect(body.messages[1].content[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });
});

describe("ScalewayVerdictModerationProvider — verdict mapping", () => {
  it("pass -> approved, no labels, modelVersion echoed", async () => {
    const out = await new ScalewayVerdictModerationProvider(
      config({ fetchImpl: fetchReturning(verdictContent("pass")) }),
    ).moderateImage(REF);
    expect(out.decision).toBe("approved");
    expect(out.labels).toEqual([]);
    expect(out.modelVersion).toBe(MODEL);
    expect(out.provider).toBe("scaleway-verdict");
  });

  it("block -> quarantine (default) with a structural label", async () => {
    const out = await new ScalewayVerdictModerationProvider(
      config({ fetchImpl: fetchReturning(verdictContent("block")) }),
    ).moderateImage(REF);
    expect(out.decision).toBe("quarantine");
    expect(out.labels).toEqual([{ category: "verdict_block", confidence: 1 }]);
    expect(out.modelVersion).toBe(MODEL);
  });

  it("block -> review when blockDecision is review", async () => {
    const out = await new ScalewayVerdictModerationProvider(
      config({ fetchImpl: fetchReturning(verdictContent("block")), blockDecision: "review" }),
    ).moderateImage(REF);
    expect(out.decision).toBe("review");
  });

  it("honours a custom blockCategory token", async () => {
    const out = await new ScalewayVerdictModerationProvider(
      config({ fetchImpl: fetchReturning(verdictContent("block")), blockCategory: "gate_hit" }),
    ).moderateImage(REF);
    expect(out.labels).toEqual([{ category: "gate_hit", confidence: 1 }]);
  });

  it("honours a custom providerName", async () => {
    const out = await new ScalewayVerdictModerationProvider(
      config({ fetchImpl: fetchReturning(verdictContent("pass")), providerName: "gate" }),
    ).moderateImage(REF);
    expect(out.provider).toBe("gate");
  });
});

describe("ScalewayVerdictModerationProvider — fail closed", () => {
  const cases: Array<[string, string]> = [
    ["no content", ""],
    ["unparseable JSON", "{not json"],
    ["missing verdict", JSON.stringify({ reason: "x" })],
    ["unknown verdict value", JSON.stringify({ verdict: "maybe", reason: "x" })],
    ["verdict not a string", JSON.stringify({ verdict: 1, reason: "x" })],
  ];
  it.each(cases)("%s -> review (never approve)", async (_label, content) => {
    const out = await new ScalewayVerdictModerationProvider(
      config({ fetchImpl: fetchReturning(content) }),
    ).moderateImage(REF);
    expect(out.decision).toBe("review");
    expect(out.labels).toEqual([]);
  });
});

describe("ScalewayVerdictModerationProvider — error classification (shared transport)", () => {
  function fetchStatus(status: number): typeof fetch {
    return vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;
  }
  it("401 -> permanent + unknownCause", async () => {
    try {
      await new ScalewayVerdictModerationProvider(config({ fetchImpl: fetchStatus(401) })).moderateImage(REF);
      expect.unreachable();
    } catch (err) {
      expect(isModerationProviderError(err)).toBe(true);
      const e = err as { retryable: boolean; unknownCause: boolean };
      expect(e.retryable).toBe(false);
      expect(e.unknownCause).toBe(true);
    }
  });
  it("429 -> retryable", async () => {
    await expect(
      new ScalewayVerdictModerationProvider(config({ fetchImpl: fetchStatus(429) })).moderateImage(REF),
    ).rejects.toMatchObject({ retryable: true });
  });
  it("network throw -> retryable + unknownCause", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("socket hangup");
    }) as unknown as typeof fetch;
    await expect(
      new ScalewayVerdictModerationProvider(config({ fetchImpl })).moderateImage(REF),
    ).rejects.toMatchObject({ retryable: true, unknownCause: true });
  });
});

describe("ScalewayVerdictModerationProvider — signal + video", () => {
  it("forwards the abort signal to fetch", async () => {
    const fetchImpl = fetchReturning(verdictContent("pass"));
    const signal = new AbortController().signal;
    await new ScalewayVerdictModerationProvider(config({ fetchImpl })).moderateImage(REF, { signal });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init as RequestInit).signal).toBe(signal);
  });
  it("video methods throw a permanent provider error", async () => {
    const p = new ScalewayVerdictModerationProvider(config());
    await expect(p.startVideoModeration({} as never)).rejects.toMatchObject({ retryable: false });
    await expect(p.getVideoModeration("job")).rejects.toMatchObject({ retryable: false });
  });
});
