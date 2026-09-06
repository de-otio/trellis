/**
 * Unit tests: media/scaleway-vision-shared.ts — the transport + fail-closed
 * error mapping shared by the Scaleway/OpenAI-compatible vision providers.
 *
 * Covers the magic-byte mime sniff (a wrong type can change how the vision
 * model decodes the image), the credential-free byte read's error mapping
 * (oversize = permanent, everything else = transient+unknown), the HTTP
 * status -> provider-error classification (401/403 permanent+alert,
 * 408/429/5xx transient+infra-fault, other 4xx permanent), and the
 * chat-completions POST's own failure modes (network error, non-2xx,
 * unparseable JSON, absent content).
 */

import { describe, expect, it, vi } from "vitest";
import {
  classifyHttpError,
  errMessage,
  isPlainObject,
  postVisionChat,
  readImageBytes,
  sniffImageMime,
  trimTrailingSlash,
} from "../../../src/lib/media/scaleway-vision-shared.js";
import { ModerationProviderError } from "../../../src/lib/media/moderation-provider.js";
import type { MediaBytesAccess } from "../../../src/lib/media/media-bytes-access.js";

describe("isPlainObject", () => {
  it("true for a plain object literal", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
  });
  it("false for an array — arrays are objects too, but not plain ones", () => {
    expect(isPlainObject([1, 2])).toBe(false);
  });
  it("false for null, a string, a number", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
  });
});

describe("trimTrailingSlash", () => {
  it("removes exactly one trailing slash", () => {
    expect(trimTrailingSlash("https://host/v1/")).toBe("https://host/v1");
  });
  it("is a no-op with no trailing slash", () => {
    expect(trimTrailingSlash("https://host/v1")).toBe("https://host/v1");
  });
});

describe("errMessage", () => {
  it("extracts .message from an Error", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
  });
  it("stringifies a non-Error thrown value", () => {
    expect(errMessage("plain string")).toBe("plain string");
    expect(errMessage(42)).toBe("42");
  });
});

describe("sniffImageMime", () => {
  it("recognises JPEG magic bytes (FF D8 FF)", () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
  });
  it("recognises PNG magic bytes", () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe("image/png");
  });
  it("recognises WEBP (RIFF....WEBP)", () => {
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffImageMime(bytes)).toBe("image/webp");
  });
  it("recognises GIF87a/GIF89a (GIF8)", () => {
    expect(sniffImageMime(Buffer.from([0x47, 0x49, 0x46, 0x38, 0, 0]))).toBe("image/gif");
  });
  it("defaults to JPEG for unrecognised bytes, never throws", () => {
    expect(sniffImageMime(Buffer.from([0, 1, 2, 3]))).toBe("image/jpeg");
  });
  it("defaults to JPEG for a too-short buffer rather than reading out of bounds", () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.alloc(0))).toBe("image/jpeg");
  });
  it("a RIFF container that is NOT WEBP (wrong bytes at offset 8) is not misidentified", () => {
    const bytes = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46,
      0,
      0,
      0,
      0,
      0x41,
      0x56,
      0x49,
      0x20, // "AVI "
    ]);
    expect(sniffImageMime(bytes)).toBe("image/jpeg");
  });
});

describe("readImageBytes", () => {
  function bytesAccess(impl: MediaBytesAccess["read"]): MediaBytesAccess {
    return { read: impl, maxBytes: 10_000_000 };
  }

  it("returns the bytes on a successful read", async () => {
    const bytes = bytesAccess(async () => Buffer.from("img"));
    const result = await readImageBytes(bytes, { bucket: "b", key: "k" });
    expect(result.toString()).toBe("img");
  });

  it("rejects immediately when the signal is already aborted, without calling read()", async () => {
    const read = vi.fn();
    const bytes = bytesAccess(read);
    const controller = new AbortController();
    controller.abort();
    await expect(
      readImageBytes(bytes, { bucket: "b", key: "k" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ retryable: true });
    expect(read).not.toHaveBeenCalled();
  });

  it("maps an oversize read failure to PERMANENT (not retryable, cause known)", async () => {
    const err = Object.assign(new Error("too big"), { name: "MediaBytesTooLargeError" });
    const bytes = bytesAccess(async () => {
      throw err;
    });
    await expect(readImageBytes(bytes, { bucket: "b", key: "k" })).rejects.toMatchObject({
      retryable: false,
      unknownCause: false,
    });
  });

  it("maps any OTHER read failure to transient + unknown cause (an infra fault, not a classifier verdict)", async () => {
    const bytes = bytesAccess(async () => {
      throw new Error("network blip");
    });
    await expect(readImageBytes(bytes, { bucket: "b", key: "k" })).rejects.toMatchObject({
      retryable: true,
      unknownCause: true,
    });
  });

  it("thrown ModerationProviderError is always the type, never a bare Error", async () => {
    const bytes = bytesAccess(async () => {
      throw new Error("x");
    });
    await expect(readImageBytes(bytes, { bucket: "b", key: "k" })).rejects.toBeInstanceOf(
      ModerationProviderError,
    );
  });
});

describe("classifyHttpError", () => {
  it("401/403 -> permanent, unknownCause (alert; a credential/scope misconfiguration)", () => {
    for (const status of [401, 403]) {
      const err = classifyHttpError(status);
      expect(err.retryable).toBe(false);
      expect(err.unknownCause).toBe(true);
      expect(err.infraFault).toBe(true); // implied by unknownCause
    }
  });

  it("408/429/5xx -> transient + infraFault (retry within the bound, AND alert)", () => {
    for (const status of [408, 429, 500, 503]) {
      const err = classifyHttpError(status);
      expect(err.retryable).toBe(true);
      expect(err.infraFault).toBe(true);
    }
  });

  it("other 4xx -> permanent, NOT an infra fault (the request was rejected for these bytes)", () => {
    const err = classifyHttpError(400);
    expect(err.retryable).toBe(false);
    expect(err.infraFault).toBe(false);
    expect(err.unknownCause).toBe(false);
  });

  it("boundary: 407 is NOT in the transient set (only 408/429/5xx are)", () => {
    const err = classifyHttpError(407);
    expect(err.retryable).toBe(false);
    expect(err.infraFault).toBe(false);
  });

  it("boundary: exactly 500 is transient (>= 500)", () => {
    expect(classifyHttpError(500).retryable).toBe(true);
  });
});

describe("postVisionChat", () => {
  const baseParams = {
    baseUrl: "https://vision.example.com/v1/",
    apiKey: "test-key",
    model: "test-model",
    imageBytes: Buffer.from([0xff, 0xd8, 0xff]),
    systemPrompt: "system",
    userPrompt: "user",
    maxOutputTokens: 100,
    responseSchemaName: "verdict",
    responseSchema: { type: "object" },
  };

  it("POSTs to <baseUrl>/chat/completions (trailing slash trimmed) and returns content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "test-model-v1",
          choices: [{ message: { content: "the-verdict-json" } }],
        }),
        { status: 200 },
      ),
    );
    const result = await postVisionChat({ ...baseParams, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://vision.example.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({ content: "the-verdict-json", modelEcho: "test-model-v1" });
  });

  it("returns content: null when the response carries no choices", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const result = await postVisionChat({ ...baseParams, fetchImpl });
    expect(result.content).toBeNull();
    expect(result.modelEcho).toBeUndefined();
  });

  it("throws a transient+unknownCause ModerationProviderError on a network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(postVisionChat({ ...baseParams, fetchImpl })).rejects.toMatchObject({
      retryable: true,
      unknownCause: true,
    });
  });

  it("a non-2xx status is classified via classifyHttpError (429 -> transient+infraFault)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    await expect(postVisionChat({ ...baseParams, fetchImpl })).rejects.toMatchObject({
      retryable: true,
      infraFault: true,
    });
  });

  it("throws transient+unknownCause when the 2xx body is not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json{{{", { status: 200 }));
    await expect(postVisionChat({ ...baseParams, fetchImpl })).rejects.toMatchObject({
      retryable: true,
      unknownCause: true,
    });
  });

  it("builds a data: URI with the sniffed mime type, not a hardcoded one", async () => {
    let capturedBody: any;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    });
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    await postVisionChat({ ...baseParams, imageBytes: pngBytes, fetchImpl });
    const imageUrl = capturedBody.messages[1].content[0].image_url.url;
    expect(imageUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("forwards the AbortSignal to fetch", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const controller = new AbortController();
    await postVisionChat({ ...baseParams, fetchImpl, signal: controller.signal });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });
});
