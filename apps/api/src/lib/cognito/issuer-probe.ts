/**
 * OIDC issuer probe.
 *
 * Before registering an OIDC IdP with Cognito, GET the issuer's well-known
 * configuration to confirm the URL points at a working OIDC provider.
 *
 * Security constraints (T5 — issuer probe is the trellis HTTP egress surface
 * most exposed to admin-supplied URLs):
 *  - HTTPS only.
 *  - Hostname must resolve to a non-private, non-loopback, non-link-local IP
 *    (RFC 6890). Both IPv4 and IPv6 are checked.
 *  - HTTP redirects are rejected (`redirect: "manual"`); we never follow.
 *  - Response body is capped at 1 MiB.
 *  - Timeout 5 s.
 *  - Body must be JSON with the required OIDC discovery fields.
 */
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { Agent } from "undici";

const PROBE_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ISSUER_URL_LENGTH = 2048;
const WELL_KNOWN_PATH = "/.well-known/openid-configuration";

export type IssuerProbeFailureReason =
  | "INVALID_URL"
  | "INSECURE_SCHEME"
  | "PRIVATE_HOST"
  | "DNS_ERROR"
  | "REDIRECT_BLOCKED"
  | "HTTP_ERROR"
  | "BODY_TOO_LARGE"
  | "INVALID_JSON"
  | "MISSING_ENDPOINTS"
  | "TIMEOUT"
  | "NETWORK_ERROR";

export interface IssuerProbeSuccess {
  ok: true;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint?: string;
}

export interface IssuerProbeFailure {
  ok: false;
  reason: IssuerProbeFailureReason;
  message: string;
}

export type IssuerProbeResult = IssuerProbeSuccess | IssuerProbeFailure;

export interface IssuerProbeOptions {
  /** Override the fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  /** Override the DNS resolver (tests). */
  resolveHostname?: (hostname: string) => Promise<string[]>;
  /** Override the timeout in ms. Defaults to 5000. */
  timeoutMs?: number;
  /**
   * Override the pinned-dispatcher factory (tests). Production binds this to
   * `defaultPinnedDispatcher`, which builds a undici Agent whose connect.lookup
   * returns the validated IP — preventing DNS-rebinding TOCTOU between the
   * private-IP check and the actual TCP connect.
   */
  dispatcherFactory?: (validatedIp: string, family: 4 | 6) => unknown;
}

function fail(reason: IssuerProbeFailureReason, message: string): IssuerProbeFailure {
  return { ok: false, reason, message };
}

function defaultResolve(hostname: string): Promise<string[]> {
  return dns.lookup(hostname, { all: true, verbatim: true })
    .then((addrs) => addrs.map((a) => a.address));
}

/**
 * Returns true if the IPv4 address is in any RFC 6890 special-purpose range
 * we want to refuse: loopback, private, link-local, broadcast, etc.
 */
export function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = m.slice(1, 5).map((s) => Number(s));
  if (o.some((x) => x < 0 || x > 255)) return true;
  const [a, b] = [o[0]!, o[1]!];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * Returns true if the IPv6 address is in a private/loopback/link-local/etc.
 * range. Performs a normalized prefix comparison; we expand `::` and ignore
 * zone identifiers.
 */
export function isPrivateIPv6(ip: string): boolean {
  if (!ip.includes(":")) return false;
  const stripped = ip.split("%")[0]!.toLowerCase();

  if (stripped === "::1" || stripped === "::") return true;

  const segs = expandIPv6(stripped);
  if (!segs) return true;

  if (segs[0] === 0 && segs.slice(0, 7).every((s) => s === 0) && segs[7] === 1) return true;

  if ((segs[0]! & 0xfe00) === 0xfc00) return true;

  if ((segs[0]! & 0xffc0) === 0xfe80) return true;

  if ((segs[0]! & 0xff00) === 0xff00) return true;

  // 2001:db8::/32 — RFC 3849 documentation prefix; not routable, must not
  // be reachable from the issuer probe.
  if (segs[0] === 0x2001 && segs[1] === 0x0db8) return true;

  if (
    segs[0] === 0 &&
    segs[1] === 0 &&
    segs[2] === 0 &&
    segs[3] === 0 &&
    segs[4] === 0 &&
    segs[5] === 0xffff
  ) {
    const v4 = `${(segs[6]! >> 8) & 0xff}.${segs[6]! & 0xff}.${(segs[7]! >> 8) & 0xff}.${segs[7]! & 0xff}`;
    return isPrivateIPv4(v4);
  }

  return false;
}

function expandIPv6(ip: string): number[] | null {
  let work = ip;
  let v4Tail: [number, number] | null = null;
  const v4Match = /([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$/.exec(work);
  if (v4Match) {
    const o = v4Match[1]!.split(".").map((s) => Number(s));
    if (o.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return null;
    v4Tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    work = work.slice(0, work.length - v4Match[1]!.length).replace(/:$/, "");
  }
  const parts = work.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const totalAfterHeadTail = head.length + tail.length + (v4Tail ? 2 : 0);
  const missing = 8 - totalAfterHeadTail;
  if (parts.length === 2) {
    if (missing < 0) return null;
  } else if (missing !== 0) {
    return null;
  }
  const fill = parts.length === 2 ? new Array<string>(missing).fill("0") : [];
  const filled = [...head, ...fill, ...tail];
  const out: number[] = [];
  for (const s of filled) {
    if (!/^[0-9a-f]{0,4}$/.test(s)) return null;
    out.push(parseInt(s || "0", 16));
  }
  if (v4Tail) out.push(v4Tail[0], v4Tail[1]);
  if (out.length !== 8) return null;
  return out;
}

/**
 * Probe an OIDC issuer's well-known configuration. Returns a discriminated
 * result; callers map failures onto 422 with a remediation message.
 */
export async function probeOidcIssuer(
  issuerUrl: string,
  options: IssuerProbeOptions = {},
): Promise<IssuerProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  if (issuerUrl.length > MAX_ISSUER_URL_LENGTH) {
    return fail("INVALID_URL", "issuerUrl exceeds maximum length");
  }

  let url: URL;
  try {
    url = new URL(issuerUrl);
  } catch {
    return fail("INVALID_URL", "issuerUrl must be a valid absolute URL");
  }

  if (url.protocol !== "https:") {
    return fail("INSECURE_SCHEME", "issuerUrl must use https://");
  }

  if (url.username || url.password) {
    return fail("INVALID_URL", "issuerUrl must not include credentials");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const resolve = options.resolveHostname ?? defaultResolve;

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return fail("DNS_ERROR", "Could not resolve issuerUrl hostname");
  }
  if (addresses.length === 0) {
    return fail("DNS_ERROR", "Could not resolve issuerUrl hostname");
  }
  for (const addr of addresses) {
    if (addr.includes(":")) {
      if (isPrivateIPv6(addr)) {
        return fail("PRIVATE_HOST", "issuerUrl resolves to a private or loopback IP");
      }
    } else {
      if (isPrivateIPv4(addr)) {
        return fail("PRIVATE_HOST", "issuerUrl resolves to a private or loopback IP");
      }
    }
  }

  // Pin the connect step to the IP we just validated. Without this, Node's
  // fetch performs its own DNS lookup at request time, which lets a TTL=0
  // attacker swap the public IP for a private one between validate and
  // connect (DNS-rebinding TOCTOU).
  const validatedIp = addresses[0]!;
  const validatedFamily = isIP(validatedIp);

  const baseHref = url.toString().endsWith("/") ? url.toString() : url.toString() + "/";
  const probeUrl = baseHref + ".well-known/openid-configuration";

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const factory = options.dispatcherFactory ?? defaultPinnedDispatcher;
  let pinnedDispatcher: unknown;
  if (validatedFamily === 4 || validatedFamily === 6) {
    pinnedDispatcher = factory(validatedIp, validatedFamily);
  }

  try {
    return await runProbe(probeUrl, fetchImpl, controller, timer, pinnedDispatcher);
  } finally {
    if (pinnedDispatcher && typeof (pinnedDispatcher as { close?: () => Promise<void> }).close === "function") {
      await (pinnedDispatcher as { close: () => Promise<void> })
        .close()
        .catch(() => undefined);
    }
  }
}

function defaultPinnedDispatcher(validatedIp: string, family: 4 | 6): Agent {
  return new Agent({
    connect: {
      lookup: (
        _hostname: string,
        _opts: unknown,
        cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
      ) => cb(null, validatedIp, family),
    },
  });
}

async function runProbe(
  probeUrl: string,
  fetchImpl: typeof fetch,
  controller: AbortController,
  timer: NodeJS.Timeout,
  pinnedDispatcher: unknown,
): Promise<IssuerProbeResult> {
  let response: Response;
  try {
    const init: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: controller.signal,
    };
    if (pinnedDispatcher) {
      init.dispatcher = pinnedDispatcher;
    }
    response = await fetchImpl(probeUrl, init);
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return fail("TIMEOUT", "Probe timed out");
    }
    return fail("NETWORK_ERROR", "Could not reach issuerUrl");
  }
  clearTimeout(timer);

  if (response.status >= 300 && response.status < 400) {
    return fail("REDIRECT_BLOCKED", "issuerUrl responded with a redirect; redirects are not followed");
  }
  if (!response.ok) {
    return fail("HTTP_ERROR", `Issuer returned HTTP ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return fail("NETWORK_ERROR", "Empty response body");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          return fail("BODY_TOO_LARGE", "Issuer response exceeded 1 MiB");
        }
        chunks.push(value);
      }
    }
  } catch {
    return fail("NETWORK_ERROR", "Failed reading issuer response");
  }

  const body = new TextDecoder("utf-8").decode(concat(chunks));
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return fail("INVALID_JSON", "Issuer response was not valid JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return fail("INVALID_JSON", "Issuer response was not a JSON object");
  }

  const conf = json as Record<string, unknown>;
  const issuer = typeof conf.issuer === "string" ? conf.issuer : "";
  const authorizationEndpoint =
    typeof conf.authorization_endpoint === "string" ? conf.authorization_endpoint : "";
  const tokenEndpoint = typeof conf.token_endpoint === "string" ? conf.token_endpoint : "";
  const jwksUri = typeof conf.jwks_uri === "string" ? conf.jwks_uri : "";
  const userinfoEndpoint =
    typeof conf.userinfo_endpoint === "string" ? conf.userinfo_endpoint : undefined;

  if (!issuer || !authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    return fail(
      "MISSING_ENDPOINTS",
      "Issuer well-known is missing one of: issuer, authorization_endpoint, token_endpoint, jwks_uri",
    );
  }

  return {
    ok: true,
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    ...(userinfoEndpoint ? { userinfoEndpoint } : {}),
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
