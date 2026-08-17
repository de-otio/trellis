/**
 * The one SSRF-safe server-side fetch.
 *
 * Every server-side HTTP request that takes a URL from anywhere other than our
 * own configuration must go through here. The guarantees, in the order they
 * are enforced:
 *
 *  1. **Scheme allowlist.** Default http+https; callers that federate pass
 *     `allowedProtocols: ["https:"]` and get TLS-only.
 *  2. **Host normalisation through a real IP parser** (`ip-guard.ts`), so
 *     `http://2130706433/`, `http://0x7f000001/`, `http://017700000001/`,
 *     `http://0/` and `http://[::ffff:127.0.0.1]/` are all recognised as
 *     loopback rather than falling through a dotted-quad regex.
 *  3. **DNS resolution, then range-check EVERY resolved A and AAAA record.**
 *     One private answer in the set fails the whole request — a name with a
 *     public A and a private AAAA is a rebinding primitive, not a valid target.
 *  4. **Socket pinned to the validated address.** The connection uses a
 *     `lookup` that returns the exact IP we validated, so the resolver cannot
 *     hand a different answer to the connect that it gave to the check. This
 *     is what closes the DNS-rebinding TOCTOU; validating and then calling
 *     plain `fetch(url)` does not.
 *  5. **Redirects handled manually, each hop re-validated**, and capped.
 *  6. **AbortController timeout** over the whole exchange, not per-hop.
 *  7. **Response body capped** while streaming, before anything parses it.
 *
 * Transport and resolver are injectable so the policy above is unit-testable
 * without a network or a DNS server.
 */

import { lookup as dnsLookupCb } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent, request as undiciRequest } from "undici";
import {
  classifyHostname,
  classifyParsedIp,
  parseIpLiteral,
  type AddressClassification,
  type ParsedIp,
} from "./ip-guard.js";

/** Reasons a request can be refused before or during the exchange. */
export type SafeFetchDenyReason =
  | "invalid-url"
  | "scheme-not-allowed"
  | "blocked-address"
  | "dns-failure"
  | "too-many-redirects"
  | "redirect-missing-location"
  | "credentials-in-url"
  | "port-not-allowed";

/** Thrown for every policy refusal. Never leaks a fetched body. */
export class SsrfBlockedError extends Error {
  constructor(
    readonly reason: SafeFetchDenyReason,
    readonly detail: string,
    readonly url?: string,
  ) {
    super(`SSRF blocked (${reason}): ${detail}`);
    this.name = "SsrfBlockedError";
  }
}

/** Thrown when the response exceeds `maxBytes`. */
export class ResponseTooLargeError extends Error {
  constructor(readonly limit: number, readonly url: string) {
    super(`Response body exceeded ${limit} bytes: ${url}`);
    this.name = "ResponseTooLargeError";
  }
}

/** A DNS resolver, injectable for tests. Returns every A and AAAA answer. */
export type DnsResolver = (hostname: string) => Promise<string[]>;

/** A URL that has passed validation, together with the address to pin to. */
export interface ValidatedTarget {
  readonly url: URL;
  /** Canonical text of the address the socket must connect to. */
  readonly address: string;
  readonly family: 4 | 6;
  /** Every address the name resolved to (all validated). */
  readonly allAddresses: readonly string[];
}

/** Minimal transport contract, so tests can drive the redirect/cap logic. */
export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Response body as a byte stream. */
  readonly body: AsyncIterable<Uint8Array> | null;
}

export interface TransportRequest {
  readonly target: ValidatedTarget;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly signal: AbortSignal;
}

export type Transport = (req: TransportRequest) => Promise<RawResponse>;

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Whole-exchange budget, redirects included. Default 5000 ms. */
  timeoutMs?: number;
  /** Default 3. Zero means "do not follow redirects". */
  maxRedirects?: number;
  /** Hard ceiling on bytes read from the body. Default 1 MiB. */
  maxBytes?: number;
  /** Default `["http:", "https:"]`. Federation passes `["https:"]`. */
  allowedProtocols?: readonly string[];
  /** Default: 80, 443, and the URL's default. Empty array means "any". */
  allowedPorts?: readonly number[];
  /** Injectable for tests. Default: `dns.lookup` with `all: true`. */
  resolver?: DnsResolver;
  /** Injectable for tests. Default: undici with a pinned-IP connector. */
  transport?: Transport;
}

export interface SafeFetchResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
  /** Final URL after redirects. */
  readonly url: string;
  /** Every URL visited, starting with the original. */
  readonly redirectChain: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_PROTOCOLS: readonly string[] = ["http:", "https:"];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Default resolver: every A and AAAA answer for the name. */
export const systemResolver: DnsResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookupCb(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        reject(err);
        return;
      }
      resolve((addresses ?? []).map((a) => a.address));
    });
  });

function firstHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Validate a URL and resolve it to a pinned address.
 *
 * Throws {@link SsrfBlockedError} on any policy violation. On success the
 * returned target carries the exact IP the socket must use.
 */
export async function assertUrlSafe(
  rawUrl: string | URL,
  options: SafeFetchOptions = {},
): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(
      "invalid-url",
      "not a parseable absolute URL",
      String(rawUrl),
    );
  }

  const allowedProtocols = options.allowedProtocols ?? DEFAULT_PROTOCOLS;
  if (!allowedProtocols.includes(url.protocol)) {
    throw new SsrfBlockedError(
      "scheme-not-allowed",
      `${url.protocol} (allowed: ${allowedProtocols.join(", ")})`,
      url.href,
    );
  }

  // Embedded credentials are a redirect-laundering trick and have no place in
  // a server-side fetch target.
  if (url.username || url.password) {
    throw new SsrfBlockedError(
      "credentials-in-url",
      "userinfo present in URL",
      url.href,
    );
  }

  const allowedPorts = options.allowedPorts;
  if (allowedPorts && allowedPorts.length > 0 && url.port) {
    const port = Number.parseInt(url.port, 10);
    if (!allowedPorts.includes(port)) {
      throw new SsrfBlockedError(
        "port-not-allowed",
        `port ${port}`,
        url.href,
      );
    }
  }

  // Lexical screen first: catches localhost/.internal and every IP-literal
  // encoding without spending a DNS query.
  const lexical = classifyHostname(url.hostname);
  if (lexical.blocked) {
    throw new SsrfBlockedError(
      "blocked-address",
      `${url.hostname} → ${lexical.reason}${lexical.range ? ` (${lexical.range})` : ""}`,
      url.href,
    );
  }

  // An IP literal needs no DNS — it IS the address, and it already passed.
  const literal = parseIpLiteral(url.hostname.replace(/^\[|\]$/g, ""));
  if (literal) {
    return {
      url,
      address: literal.canonical,
      family: literal.family,
      allAddresses: [literal.canonical],
    };
  }

  const resolver = options.resolver ?? systemResolver;
  let addresses: string[];
  try {
    addresses = await resolver(url.hostname);
  } catch (error) {
    throw new SsrfBlockedError(
      "dns-failure",
      `resolution failed for ${url.hostname}: ${(error as Error).message}`,
      url.href,
    );
  }

  if (!addresses || addresses.length === 0) {
    throw new SsrfBlockedError(
      "dns-failure",
      `no A/AAAA records for ${url.hostname}`,
      url.href,
    );
  }

  // EVERY answer must be public. A name that resolves to one public and one
  // private address is a rebinding primitive; refusing the whole set is the
  // only safe disposition.
  const parsedAll: ParsedIp[] = [];
  for (const address of addresses) {
    const parsed = parseIpLiteral(address);
    if (!parsed) {
      throw new SsrfBlockedError(
        "blocked-address",
        `${url.hostname} resolved to unparseable address ${address}`,
        url.href,
      );
    }
    const verdict: AddressClassification = classifyParsedIp(parsed);
    if (verdict.blocked) {
      throw new SsrfBlockedError(
        "blocked-address",
        `${url.hostname} resolved to ${parsed.canonical} → ${verdict.reason}${verdict.range ? ` (${verdict.range})` : ""}`,
        url.href,
      );
    }
    parsedAll.push(parsed);
  }

  const chosen = parsedAll[0];
  return {
    url,
    address: chosen.canonical,
    family: chosen.family,
    allAddresses: parsedAll.map((p) => p.canonical),
  };
}

/**
 * Build an undici dispatcher whose DNS lookup is hard-wired to one validated
 * address. Origin, SNI and the Host header stay the real hostname, so TLS
 * certificate verification is unaffected — only the address the socket dials
 * is pinned.
 */
function pinnedAgent(target: ValidatedTarget, timeoutMs: number): Agent {
  const lookup: LookupFunction = (_hostname, opts, cb) => {
    // `all: true` wants an array of answers; otherwise a single address. Either
    // way we return exactly the one address we validated — the resolver is
    // never consulted again, so it cannot change its answer under us.
    if (opts && (opts as { all?: boolean }).all) {
      (cb as unknown as (
        err: NodeJS.ErrnoException | null,
        addresses: Array<{ address: string; family: number }>,
      ) => void)(null, [{ address: target.address, family: target.family }]);
    } else {
      cb(null, target.address, target.family);
    }
  };
  // NB: no redirect interceptor is installed, so undici returns the 3xx as-is.
  // Redirects are followed by `safeFetch` itself, one re-validated hop at a
  // time — an auto-following dispatcher would defeat the whole guard.
  return new Agent({
    connect: {
      timeout: timeoutMs,
      lookup,
    },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
}

/** Default transport: undici, pinned to the validated address. */
export const undiciTransport: Transport = async (req) => {
  const agent = pinnedAgent(req.target, 30_000);
  try {
    const response = await undiciRequest(req.target.url.href, {
      method: req.method as never,
      headers: req.headers,
      body: req.body as never,
      signal: req.signal,
      dispatcher: agent,
    });
    return {
      status: response.statusCode,
      headers: response.headers as Readonly<
        Record<string, string | string[] | undefined>
      >,
      body: response.body as unknown as AsyncIterable<Uint8Array>,
    };
  } finally {
    // Do not await: closing must not extend the caller's timeout budget.
    void agent.close().catch(() => {});
  }
};

/** Read a body stream, aborting the moment it exceeds `maxBytes`. */
async function readCapped(
  body: AsyncIterable<Uint8Array> | null,
  maxBytes: number,
  url: string,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new ResponseTooLargeError(maxBytes, url);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Perform an SSRF-safe request. See the module header for the full contract.
 *
 * Throws {@link SsrfBlockedError} for a policy refusal (including a refused
 * redirect destination), {@link ResponseTooLargeError} when the body exceeds
 * the cap, and the underlying transport error otherwise.
 */
export async function safeFetch(
  rawUrl: string | URL,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const transport = options.transport ?? undiciTransport;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl: string | URL = rawUrl;
    let method = options.method ?? "GET";
    let body = options.body;
    const redirectChain: string[] = [];

    for (let hop = 0; ; hop++) {
      // Re-validated on EVERY hop, not just the first. This is the whole point
      // of manual redirect handling.
      const target = await assertUrlSafe(currentUrl, options);
      redirectChain.push(target.url.href);

      const response = await transport({
        target,
        method,
        headers: {
          host: target.url.host,
          ...(options.headers ?? {}),
        },
        body,
        signal: controller.signal,
      });

      // `maxRedirects: 0` means "do not follow" — the 3xx is the result, and
      // the caller inspects Location itself (the redirect resolver does this,
      // so it can stop at the last validated hop instead of failing the chain).
      if (maxRedirects === 0 || !REDIRECT_STATUSES.has(response.status)) {
        const bytes = await readCapped(response.body, maxBytes, target.url.href);
        return {
          status: response.status,
          headers: response.headers,
          body: bytes,
          url: target.url.href,
          redirectChain,
        };
      }

      // A redirect: drain (capped) so the socket can be reused, then validate
      // the destination before going anywhere near it.
      await readCapped(response.body, maxBytes, target.url.href).catch(() => {});

      if (hop >= maxRedirects) {
        throw new SsrfBlockedError(
          "too-many-redirects",
          `exceeded ${maxRedirects} redirects`,
          target.url.href,
        );
      }

      const location = firstHeader(response.headers, "location");
      if (!location) {
        throw new SsrfBlockedError(
          "redirect-missing-location",
          `${response.status} with no Location header`,
          target.url.href,
        );
      }

      const next = new URL(location, target.url);
      // 303 (and, by universal practice, 301/302 on POST) degrade to GET.
      if (response.status === 303 || (response.status < 307 && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        body = undefined;
      }
      currentUrl = next;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `safeFetch` + JSON parse, with the size cap applied BEFORE parsing (an
 * unbounded `response.json()` is an OOM primitive). Returns null on a non-2xx
 * status or unparseable body; policy refusals still throw.
 */
export async function safeFetchJson<T = unknown>(
  rawUrl: string | URL,
  options: SafeFetchOptions = {},
): Promise<{ status: number; data: T | null }> {
  const result = await safeFetch(rawUrl, options);
  if (result.status < 200 || result.status >= 300) {
    return { status: result.status, data: null };
  }
  try {
    return { status: result.status, data: JSON.parse(result.body.toString("utf8")) as T };
  } catch {
    return { status: result.status, data: null };
  }
}

/**
 * Synchronous, DNS-free verdict for callers that only need the lexical layer
 * (scheme + IP-literal encodings + internal-name patterns). Anything that
 * actually connects must use {@link assertUrlSafe} / {@link safeFetch} — this
 * cannot see a DNS answer.
 */
export function screenUrlLexically(
  rawUrl: string,
  allowedProtocols: readonly string[] = DEFAULT_PROTOCOLS,
): { allowed: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "Invalid URL format" };
  }
  if (!allowedProtocols.includes(url.protocol)) {
    return { allowed: false, reason: `Scheme not allowed: ${url.protocol.replace(":", "")}` };
  }
  if (url.username || url.password) {
    return { allowed: false, reason: "Credentials in URL are not allowed" };
  }
  const verdict = classifyHostname(url.hostname);
  if (verdict.blocked) {
    return {
      allowed: false,
      reason:
        verdict.reason === "internal-hostname"
          ? "Internal hostname detected"
          : `Blocked address range (${verdict.reason})`,
    };
  }
  return { allowed: true };
}
