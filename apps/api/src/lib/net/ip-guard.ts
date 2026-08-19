/**
 * IP-literal parsing and address-range classification for SSRF defence.
 *
 * This module is deliberately pure and dependency-free: no DNS, no sockets, no
 * env. It answers two questions and nothing else:
 *
 *   1. `parseIpLiteral(host)` — is this host string an IP address, in ANY of
 *      the encodings a URL parser (or a careless `fetch`) will happily accept:
 *      dotted-quad, bare decimal (`2130706433`), hex (`0x7f000001`), octal
 *      (`017700000001`), short forms (`127.1`, `0`), bracketed or bare IPv6,
 *      IPv4-mapped IPv6 (`::ffff:127.0.0.1`)? Returns a CANONICAL form, so the
 *      range check downstream sees one representation, never fourteen.
 *   2. `classifyAddress(ip)` — does this address fall in a range we must never
 *      let a server-side fetch reach: loopback, RFC1918 private, link-local
 *      (which is where every cloud metadata service lives), unique-local,
 *      CGNAT, multicast, reserved, documentation, unspecified?
 *
 * The lexical checks in `link-security-handler.ts` used a dotted-quad regex,
 * which meant `http://2130706433/` and `http://0x7f000001/` sailed through to
 * undici, which cheerfully connected them to loopback. Everything here exists
 * so that class of bypass has exactly one place to be fixed.
 *
 * Ranges are expressed as CIDR and compiled once; adding a range is a one-line
 * table edit, not a new branch in a conditional.
 */

/** A parsed IP literal, normalised to one canonical textual form. */
export interface ParsedIp {
  /** 4 for IPv4 (including an unwrapped IPv4-mapped IPv6), 6 otherwise. */
  readonly family: 4 | 6;
  /** Canonical text: dotted-quad for v4, lowercase compressed for v6. */
  readonly canonical: string;
  /** Big-endian bytes: 4 for v4, 16 for v6. */
  readonly bytes: Uint8Array;
}

/** Why an address (or host) was rejected. */
export type BlockReason =
  | "loopback"
  | "private"
  | "link-local"
  | "unique-local"
  | "cgnat"
  | "multicast"
  | "reserved"
  | "unspecified"
  | "documentation"
  | "broadcast"
  | "internal-hostname";

export interface AddressClassification {
  readonly blocked: boolean;
  readonly reason?: BlockReason;
  /** Human-readable range label, for logs. */
  readonly range?: string;
}

// ---------------------------------------------------------------------------
// IPv4 parsing (WHATWG-URL-compatible: decimal / octal / hex, 1–4 parts)
// ---------------------------------------------------------------------------

/**
 * Parse one IPv4 "part" the way the URL Standard's IPv4 parser does:
 * `0x`-prefixed = hex, leading `0` = octal, otherwise decimal. Returns null on
 * anything malformed (empty, wrong digits, out of range).
 */
function parseIpv4Part(part: string): number | null {
  if (part.length === 0) return null;
  let radix = 10;
  let digits = part;
  if (/^0[xX]/.test(part)) {
    radix = 16;
    digits = part.slice(2);
    if (digits.length === 0) return 0; // "0x" === 0, per the URL Standard
  } else if (part.length > 1 && part[0] === "0") {
    radix = 8;
    digits = part.slice(1);
  }
  const valid =
    radix === 16
      ? /^[0-9a-fA-F]+$/
      : radix === 8
        ? /^[0-7]+$/
        : /^[0-9]+$/;
  if (!valid.test(digits)) return null;
  const value = Number.parseInt(digits, radix);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/**
 * Parse an IPv4 address in any of the shorthand encodings. Handles the
 * "last part absorbs the remaining octets" rule, so `127.1` → 127.0.0.1 and
 * `2130706433` → 127.0.0.1.
 */
export function parseIpv4(host: string): ParsedIp | null {
  if (host.length === 0) return null;
  // A trailing dot is legal in the URL host grammar ("127.0.0.1.").
  const trimmed = host.endsWith(".") ? host.slice(0, -1) : host;
  if (trimmed.length === 0) return null;
  const parts = trimmed.split(".");
  if (parts.length > 4) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    const n = parseIpv4Part(part);
    if (n === null) return null;
    numbers.push(n);
  }

  // Every part but the last must fit in one octet.
  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i] > 255) return null;
  }
  // The last part absorbs the remaining octets.
  const last = numbers[numbers.length - 1];
  const remaining = 4 - (numbers.length - 1);
  if (last >= 256 ** remaining) return null;

  let ipv4 = last;
  for (let i = 0; i < numbers.length - 1; i++) {
    ipv4 += numbers[i] * 256 ** (3 - i);
  }
  ipv4 = ipv4 >>> 0;

  const bytes = new Uint8Array([
    (ipv4 >>> 24) & 0xff,
    (ipv4 >>> 16) & 0xff,
    (ipv4 >>> 8) & 0xff,
    ipv4 & 0xff,
  ]);
  return { family: 4, canonical: bytes.join("."), bytes };
}

// ---------------------------------------------------------------------------
// IPv6 parsing
// ---------------------------------------------------------------------------

/** Render 16 bytes as a lowercase, `::`-compressed IPv6 string. */
function canonicalIpv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);

  // Longest run of zero groups (length >= 2) gets compressed to "::".
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) {
    bestStart = -1;
    bestLen = 0;
  }

  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    if (bestStart !== -1 && i === bestStart) {
      out.push("");
      i += bestLen - 1;
      if (i === 7) out.push("");
      continue;
    }
    out.push(groups[i].toString(16));
  }
  const joined = out.join(":");
  return bestStart === 0 ? `:${joined}` : joined;
}

/**
 * Parse an IPv6 literal, with or without surrounding brackets, including the
 * `::ffff:1.2.3.4` dotted-tail form. Zone ids (`%eth0`) are rejected outright:
 * a scoped address has no business in a URL we are about to fetch.
 */
export function parseIpv6(host: string): ParsedIp | null {
  let text = host;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (text.length === 0 || text.includes("%")) return null;
  if (!text.includes(":")) return null;

  const doubleColonCount = (text.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let head = text;
  let tail = "";
  if (doubleColonCount === 1) {
    const idx = text.indexOf("::");
    head = text.slice(0, idx);
    tail = text.slice(idx + 2);
  }

  const headParts = head.length ? head.split(":") : [];
  const tailParts = tail.length ? tail.split(":") : [];
  if (headParts.includes("") || tailParts.includes("")) return null;

  // An embedded dotted-quad may only appear as the final component.
  const expand = (parts: string[], isTail: boolean): number[] | null => {
    const groups: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.includes(".")) {
        if (i !== parts.length - 1) return null;
        // Strict dotted-quad only here — no octal/hex shorthand inside IPv6.
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(part)) return null;
        const octets = part.split(".").map(Number);
        if (octets.some((o) => o > 255)) return null;
        groups.push((octets[0] << 8) | octets[1]);
        groups.push((octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    void isTail;
    return groups;
  };

  const headGroups = expand(headParts, false);
  const tailGroups = expand(tailParts, true);
  if (headGroups === null || tailGroups === null) return null;

  const total = headGroups.length + tailGroups.length;
  if (doubleColonCount === 0) {
    if (total !== 8) return null;
  } else if (total > 7) {
    // "::" must stand for at least one zero group.
    return null;
  }

  const groups = [
    ...headGroups,
    ...new Array<number>(8 - total).fill(0),
    ...tailGroups,
  ];

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >>> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return { family: 6, canonical: canonicalIpv6(bytes), bytes };
}

/**
 * True when 16 bytes are an IPv4-mapped (`::ffff:0:0/96`) or IPv4-compatible
 * (`::/96`, deprecated) address, or NAT64 (`64:ff9b::/96`) — all of which
 * carry a routable-looking IPv4 in the low 32 bits.
 */
function embeddedIpv4(bytes: Uint8Array): Uint8Array | null {
  const isMapped =
    bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  const isCompat =
    bytes.slice(0, 12).every((b) => b === 0) &&
    !(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0);
  const isNat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0);
  // 6to4 (2002::/16) embeds the v4 address at bytes 2..6.
  const is6to4 = bytes[0] === 0x20 && bytes[1] === 0x02;
  if (is6to4) return bytes.slice(2, 6);
  if (isMapped || isCompat || isNat64) return bytes.slice(12, 16);
  return null;
}

/**
 * Parse a host string as an IP literal in ANY encoding. Returns null when the
 * host is a domain name (which must then go through DNS resolution).
 */
export function parseIpLiteral(host: string): ParsedIp | null {
  if (typeof host !== "string" || host.length === 0) return null;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("[") || trimmed.includes(":")) {
    return parseIpv6(trimmed);
  }
  return parseIpv4(trimmed);
}

// ---------------------------------------------------------------------------
// Range tables
// ---------------------------------------------------------------------------

interface Range {
  readonly cidr: string;
  readonly reason: BlockReason;
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

function cidr(spec: string, reason: BlockReason): Range {
  const [addr, lenText] = spec.split("/");
  const parsed = addr.includes(":") ? parseIpv6(addr) : parseIpv4(addr);
  if (!parsed) throw new Error(`ip-guard: bad CIDR in table: ${spec}`);
  return {
    cidr: spec,
    reason,
    bytes: parsed.bytes,
    prefix: Number.parseInt(lenText, 10),
  };
}

/**
 * IPv4 ranges a server-side fetch must never reach. Note 169.254.0.0/16 covers
 * every cloud metadata endpoint we care about (AWS/GCP 169.254.169.254,
 * Scaleway 169.254.42.42), and 100.64.0.0/10 covers CGNAT — which is where
 * Alibaba's 100.100.100.200 metadata service lives.
 */
const IPV4_BLOCKED: readonly Range[] = [
  cidr("0.0.0.0/8", "unspecified"), // "this network"; also `http://0/`
  cidr("10.0.0.0/8", "private"),
  cidr("100.64.0.0/10", "cgnat"),
  cidr("127.0.0.0/8", "loopback"),
  cidr("169.254.0.0/16", "link-local"), // cloud metadata
  cidr("172.16.0.0/12", "private"),
  cidr("192.0.0.0/24", "reserved"),
  cidr("192.0.2.0/24", "documentation"),
  cidr("192.168.0.0/16", "private"),
  cidr("198.18.0.0/15", "reserved"), // benchmarking
  cidr("198.51.100.0/24", "documentation"),
  cidr("203.0.113.0/24", "documentation"),
  cidr("224.0.0.0/4", "multicast"),
  cidr("240.0.0.0/4", "reserved"), // includes 255.255.255.255
];

const IPV6_BLOCKED: readonly Range[] = [
  cidr("::/128", "unspecified"),
  cidr("::1/128", "loopback"),
  cidr("100::/64", "reserved"), // discard-only
  cidr("2001:db8::/32", "documentation"),
  cidr("fc00::/7", "unique-local"),
  cidr("fe80::/10", "link-local"),
  cidr("fec0::/10", "reserved"), // deprecated site-local
  cidr("ff00::/8", "multicast"),
];

function inRange(bytes: Uint8Array, range: Range): boolean {
  const fullBytes = range.prefix >>> 3;
  const remainingBits = range.prefix & 7;
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== range.bytes[i]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[fullBytes] & mask) === (range.bytes[fullBytes] & mask);
}

const ALLOWED: AddressClassification = { blocked: false };

/**
 * Classify a parsed IP address. IPv4-mapped / NAT64 / 6to4 IPv6 addresses are
 * unwrapped and re-checked as IPv4, so `[::ffff:127.0.0.1]` cannot smuggle
 * loopback past an IPv6-only range table.
 */
export function classifyParsedIp(ip: ParsedIp): AddressClassification {
  if (ip.family === 4) {
    for (const range of IPV4_BLOCKED) {
      if (inRange(ip.bytes, range)) {
        return { blocked: true, reason: range.reason, range: range.cidr };
      }
    }
    return ALLOWED;
  }

  const embedded = embeddedIpv4(ip.bytes);
  if (embedded) {
    const asV4: ParsedIp = {
      family: 4,
      canonical: embedded.join("."),
      bytes: embedded,
    };
    const inner = classifyParsedIp(asV4);
    if (inner.blocked) return inner;
  }

  for (const range of IPV6_BLOCKED) {
    if (inRange(ip.bytes, range)) {
      return { blocked: true, reason: range.reason, range: range.cidr };
    }
  }
  return ALLOWED;
}

/**
 * Classify an address given as text (any encoding). Unparseable input is
 * treated as BLOCKED — an address we cannot understand is an address we must
 * not connect to.
 */
export function classifyAddress(address: string): AddressClassification {
  const parsed = parseIpLiteral(address);
  if (!parsed) return { blocked: true, reason: "reserved", range: "unparseable" };
  return classifyParsedIp(parsed);
}

// ---------------------------------------------------------------------------
// Hostname-level lexical checks (defence in depth ahead of DNS)
// ---------------------------------------------------------------------------

const INTERNAL_HOSTNAME_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^localhost\./i,
  /\.localhost$/i,
  /\.local$/i,
  /\.localdomain$/i,
  /\.internal$/i,
  /\.intranet$/i,
  /\.corp$/i,
  /\.home$/i,
  /\.lan$/i,
  /\.private$/i,
  /^metadata$/i,
  /^metadata\./i,
];

/**
 * Lexical hostname screen applied BEFORE DNS. Catches names that are internal
 * by construction. It is not sufficient on its own — `evil.com` with an A
 * record of 169.254.169.254 passes here and is caught by the resolve step.
 */
export function classifyHostname(hostname: string): AddressClassification {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const bare = host.endsWith(".") ? host.slice(0, -1) : host;
  if (bare.length === 0) {
    return { blocked: true, reason: "internal-hostname", range: "empty" };
  }
  const asIp = parseIpLiteral(bare);
  if (asIp) return classifyParsedIp(asIp);
  for (const pattern of INTERNAL_HOSTNAME_PATTERNS) {
    if (pattern.test(bare)) {
      return {
        blocked: true,
        reason: "internal-hostname",
        range: pattern.source,
      };
    }
  }
  return ALLOWED;
}
