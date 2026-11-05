/**
 * Postgres TLS options — one builder for every `pg.Pool` in the repo.
 *
 * Both pools used to hard-code `ssl: { rejectUnauthorized: false }` for every
 * non-local host. The comment justifying it ("the Amazon RDS root CA may not
 * be in Node's default trust store") is AWS-era; on the Scaleway profile the
 * managed Postgres publishes a per-instance CA certificate, and a connection
 * that is encrypted but never checks who it is talking to is open to anyone
 * on the path between the pod network and the endpoint (security deep pass
 * DP-7).
 *
 * Resolution, in order:
 *   1. Local host (localhost / 127.0.0.1 / [::1]) → `false`. A local Postgres
 *      (dev, CI, the standalone lane) is not configured for TLS, and asking
 *      for it fails with "server does not support SSL connections".
 *   2. `DB_SSL_CA` (PEM text, or base64 of the PEM for single-line delivery)
 *      or `DB_SSL_CA_PATH` (a mounted file) → certificate verification ON,
 *      pinned to that CA. A DNS host goes out as `servername` so SNI and the
 *      hostname check work even when the pool later dials an IP. An IP-literal
 *      host (Scaleway's Managed Postgres private endpoint) is NOT sent as
 *      `servername`: RFC 6066 forbids an IP in SNI and Node deprecates it
 *      (DEP0123) on the way to refusing it. The IP is verified against the
 *      certificate's SAN through `checkServerIdentity` instead — which `pg`
 *      needs anyway, because it hands `tls.connect` a pre-opened socket and
 *      no `host`, so without it Node would compare the certificate against
 *      its "localhost" fallback.
 *   3. Neither set on a REMOTE host → FAIL CLOSED (throws, naming the fix).
 *      The only way to the legacy unverified mode (encrypted, server never
 *      authenticated, `rejectUnauthorized: false`) is the explicit, knowing
 *      opt-in `DB_SSL_INSECURE=true`, which logs ONE warning per process.
 *
 * An unreadable `DB_SSL_CA_PATH` or an empty CA is an error, not a fallback:
 * the operator asked for verification, so silently downgrading would be the
 * worst of both.
 */

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import type { PeerCertificate } from "node:tls";

export interface DbSslEnv {
  DB_SSL_CA?: string;
  DB_SSL_CA_PATH?: string;
  /**
   * `"true"` knowingly accepts an unverified remote Postgres TLS connection
   * when no CA is configured. Falls back to `process.env.DB_SSL_INSECURE` when
   * the caller's env object does not carry it (the typed `Env` does not).
   */
  DB_SSL_INSECURE?: string;
}

/** Same shape `tls.connect` accepts for `checkServerIdentity`. */
export type DbSslCheckServerIdentity = (
  hostname: string,
  cert: PeerCertificate,
) => Error | undefined;

export type DbSslOptions =
  | false
  | {
      readonly rejectUnauthorized: true;
      readonly ca: string;
      /** DNS hosts only — an IP literal is never sent as SNI (DEP0123). */
      readonly servername?: string;
      /** IP-literal hosts only — pins the identity check to the dialled IP. */
      readonly checkServerIdentity?: DbSslCheckServerIdentity;
    }
  | { readonly rejectUnauthorized: false };

export type DbSslWarn = (message: string, context?: Record<string, unknown>) => void;

const LOCAL_HOST_RE = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/;

/** True for the connection strings the dev / CI / standalone lanes use. */
export function isLocalDbConnectionString(connectionString: string | undefined): boolean {
  return LOCAL_HOST_RE.test(connectionString ?? "");
}

let warnedOnce = false;

/** Test seam: re-arm the one-per-process warning. */
export function _resetDbSslWarningForTests(): void {
  warnedOnce = false;
}

const SAN_IP_PREFIX = "IP Address:";

/** Canonical text form of an IP literal (lower-case, compressed IPv6), or undefined if not an IP. */
function canonicalIp(ip: string): string | undefined {
  const version = isIP(ip);
  if (!version) return undefined;
  try {
    // WHATWG URL parsing is the one IP canonicaliser Node exposes; IPv6 comes
    // back bracketed on both sides, so the comparison stays consistent.
    return new URL(`http://${version === 6 ? `[${ip}]` : ip}/`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Identity check for an IP-literal endpoint: the certificate must carry the
 * dialled IP in its SAN. The `hostname` Node passes in is ignored on purpose —
 * with no `servername` and no `host` (pg supplies a socket) it is Node's
 * "localhost" fallback, not anything we dialled. Chain verification against
 * the pinned CA is unaffected; only the name check is replaced.
 *
 * Not delegated to `tls.checkServerIdentity`: on Node 24 that runs the name
 * through `domainToASCII` first, which turns a bare IPv6 literal into "" and
 * so never reaches its IP branch — an IPv6 endpoint would fail verification
 * for the wrong reason.
 */
export function ipServerIdentityCheck(ip: string): DbSslCheckServerIdentity {
  const wanted = canonicalIp(ip);
  return (_hostname, cert) => {
    const ips = (cert.subjectaltname ?? "")
      .split(", ")
      .filter((entry) => entry.startsWith(SAN_IP_PREFIX))
      .map((entry) => canonicalIp(entry.slice(SAN_IP_PREFIX.length)))
      .filter((entry): entry is string => entry !== undefined);
    if (wanted !== undefined && ips.includes(wanted)) return undefined;
    const error = new Error(
      `Hostname/IP does not match certificate's altnames: IP: ${ip} is not in the cert's list: ${ips.join(", ")}`,
    ) as Error & { code: string; host: string };
    error.code = "ERR_TLS_CERT_ALTNAME_INVALID";
    error.host = ip;
    return error;
  };
}

function hostOf(connectionString: string | undefined): string | undefined {
  if (!connectionString) return undefined;
  try {
    const host = new URL(connectionString).hostname;
    // URL keeps the brackets on an IPv6 literal; `servername` wants them off.
    return host.replace(/^\[|\]$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

function loadCa(env: DbSslEnv, readFile: (path: string) => string): string | undefined {
  const raw = env.DB_SSL_CA;
  const inline = raw?.trim();
  if (raw && inline) {
    // Hand the PEM over untouched (a trailing newline is part of the file).
    if (inline.includes("-----BEGIN")) return raw;
    // Single-line delivery: base64 of the PEM.
    const decoded = Buffer.from(inline, "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) return decoded;
    throw new Error("db-ssl: DB_SSL_CA is set but is neither a PEM certificate nor base64 of one");
  }
  const path = env.DB_SSL_CA_PATH?.trim();
  if (path) {
    let content: string;
    try {
      content = readFile(path);
    } catch (error) {
      throw new Error(
        `db-ssl: DB_SSL_CA_PATH is set but cannot be read (${(error as Error).message})`,
      );
    }
    if (!content.includes("-----BEGIN")) {
      throw new Error("db-ssl: DB_SSL_CA_PATH does not contain a PEM certificate");
    }
    return content;
  }
  return undefined;
}

/**
 * Build the `ssl` option for a `pg.Pool`.
 *
 * @param connectionString - the resolved Postgres URL (host is taken from it)
 * @param env - `DB_SSL_CA` / `DB_SSL_CA_PATH` / `DB_SSL_INSECURE`
 * @param warn - where the one-per-process DB_SSL_INSECURE warning goes
 * @param readFile - injectable for tests
 */
export function buildDbSslOptions(
  connectionString: string | undefined,
  env: DbSslEnv,
  warn?: DbSslWarn,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): DbSslOptions {
  if (isLocalDbConnectionString(connectionString)) return false;

  const ca = loadCa(env, readFile);
  if (ca) {
    const host = hostOf(connectionString);
    if (!host) return { rejectUnauthorized: true, ca };
    if (isIP(host)) {
      return { rejectUnauthorized: true, ca, checkServerIdentity: ipServerIdentityCheck(host) };
    }
    return { rejectUnauthorized: true, ca, servername: host };
  }

  // No CA on a remote host: fail closed unless the operator knowingly opted
  // in. Only the literal string "true" counts, so a typo cannot disable checks.
  const insecure = (env.DB_SSL_INSECURE ?? process.env.DB_SSL_INSECURE)?.trim().toLowerCase();
  if (insecure !== "true") {
    throw new Error(
      `db-ssl: refusing to connect to remote Postgres host "${hostOf(connectionString) ?? "<unknown>"}" without verifying its TLS certificate. Configure the database CA (DB_SSL_CA as PEM/base64, or DB_SSL_CA_PATH to a mounted PEM file), or, if you knowingly accept an unauthenticated connection, set DB_SSL_INSECURE=true.`,
    );
  }

  if (!warnedOnce) {
    warnedOnce = true;
    warn?.(
      "[db-ssl] Postgres TLS is encrypted but NOT verified: DB_SSL_INSECURE=true and neither DB_SSL_CA nor DB_SSL_CA_PATH is set, so the server certificate is not checked (rejectUnauthorized: false). Provision the database CA and set one of them.",
      { host: hostOf(connectionString) },
    );
  }
  return { rejectUnauthorized: false };
}
