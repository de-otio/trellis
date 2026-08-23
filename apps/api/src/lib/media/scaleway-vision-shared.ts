// Shared machinery for the Scaleway/OpenAI-compatible vision moderation
// providers: the credential-free byte read, the magic-byte mime sniff, the
// data-URI build, the chat-completions POST, and the HTTP error classification.
//
// Two providers use this: the CATEGORY scorer (per-category confidences) and the
// VERDICT gate (a coarse pass/block). They differ only in the response schema
// they request and how they parse the content — everything below the schema is
// identical, so it lives here once rather than in each provider. Nothing here
// interprets moderation vocabulary; it is transport plus fail-closed error
// mapping, so it ships in the public tarball like the seam it serves.

import { ModerationProviderError } from "./moderation-provider.js";
import type { ImageRef, ModerationCallOptions } from "./moderation-provider.js";
import type { MediaBytesAccess } from "./media-bytes-access.js";

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Sniff the image media type from magic bytes so the data URI carries the right
 * type — a wrong type can change how the vision model decodes the image.
 * Defaults to JPEG, the dominant poster-frame format, when unrecognised.
 */
export function sniffImageMime(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  return "image/jpeg";
}

/**
 * Read the pinned image bytes through the credential-free reader, mapping a read
 * failure onto the provider error contract (never a classifier verdict). An
 * oversize object is permanent for these bytes; anything else is transient so
 * the existing retry/DLQ bound decides, and its cause is marked unknown so an
 * infrastructure fault is not silently absorbed as caution.
 */
export async function readImageBytes(
  bytes: MediaBytesAccess,
  input: ImageRef,
  options?: ModerationCallOptions,
): Promise<Buffer> {
  if (options?.signal?.aborted) {
    throw new ModerationProviderError("aborted before read", { retryable: true });
  }
  try {
    return await bytes.read({ key: input.key, pin: input.pin });
  } catch (err) {
    const oversize =
      isPlainObject(err) && (err as { name?: unknown }).name === "MediaBytesTooLargeError";
    throw new ModerationProviderError(
      `failed to read media bytes for moderation: ${errMessage(err)}`,
      { retryable: !oversize, unknownCause: !oversize, cause: err },
    );
  }
}

/** Map an HTTP status onto the provider error contract. */
export function classifyHttpError(status: number): ModerationProviderError {
  // 401/403: a credential or scope misconfiguration — permanent, and an infra
  // fault that must alert rather than silently review forever.
  if (status === 401 || status === 403) {
    return new ModerationProviderError(`moderation endpoint rejected credentials (${status})`, {
      retryable: false,
      unknownCause: true,
    });
  }
  // 408/429 and 5xx: transient — retry within the existing bound.
  if (status === 408 || status === 429 || status >= 500) {
    return new ModerationProviderError(`moderation endpoint transient error (${status})`, {
      retryable: true,
    });
  }
  // Other 4xx: the request was rejected for these bytes — permanent.
  return new ModerationProviderError(`moderation endpoint rejected the request (${status})`, {
    retryable: false,
  });
}

/** The subset of an OpenAI-compatible chat-completions response the providers read. */
interface ChatCompletionResponse {
  readonly model?: string;
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string | null };
  }>;
}

export interface VisionChatParams {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl: typeof fetch;
  readonly imageBytes: Buffer;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxOutputTokens: number;
  /** The strict json_schema to request, and the name it is given. */
  readonly responseSchemaName: string;
  readonly responseSchema: unknown;
  readonly signal?: AbortSignal;
}

/**
 * POST one image to the chat-completions endpoint with a strict-JSON response
 * format at temperature 0, and return the raw content string (or `null` when the
 * response carried no content). Throws {@link ModerationProviderError} — never a
 * bare error — for a network failure, a non-2xx status, or an unparseable
 * envelope, so every caller inherits the same fail-closed classification.
 */
export async function postVisionChat(
  params: VisionChatParams,
): Promise<{ content: string | null; modelEcho?: string }> {
  const dataUri = `data:${sniffImageMime(params.imageBytes)};base64,${params.imageBytes.toString("base64")}`;
  const body = {
    model: params.model,
    temperature: 0,
    max_tokens: params.maxOutputTokens,
    response_format: {
      type: "json_schema",
      json_schema: { name: params.responseSchemaName, strict: true, schema: params.responseSchema },
    },
    messages: [
      { role: "system", content: params.systemPrompt },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUri } },
          { type: "text", text: params.userPrompt },
        ],
      },
    ],
  };

  let res: Response;
  try {
    res = await params.fetchImpl(`${trimTrailingSlash(params.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (err) {
    // Network failure or an abort fired by the deadline wrapper. Transient: the
    // wrapper has already committed its own verdict on abort and will discard
    // whatever we throw; for a real network error, retryable lets the bound decide.
    throw new ModerationProviderError(`moderation request failed: ${errMessage(err)}`, {
      retryable: true,
      unknownCause: true,
      cause: err,
    });
  }

  if (!res.ok) {
    throw classifyHttpError(res.status);
  }

  let json: ChatCompletionResponse;
  try {
    json = (await res.json()) as ChatCompletionResponse;
  } catch (err) {
    throw new ModerationProviderError(`moderation response was not valid JSON: ${errMessage(err)}`, {
      retryable: true,
      unknownCause: true,
      cause: err,
    });
  }

  const content = json.choices?.[0]?.message?.content;
  return {
    content: typeof content === "string" ? content : null,
    ...(typeof json.model === "string" ? { modelEcho: json.model } : {}),
  };
}
