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
 *      pinned to that CA, `servername` set to the URL host so SNI and
 *      hostname checks work even when the pool later dials an IP.
 *   3. Neither set → the legacy unverified mode, with ONE warning per process
 *      naming the variable. This branch exists so consumers that have not yet
 *      provisioned a CA keep working; a follow-up flips it to fail-closed
 *      once every deployment sets one.
 *
 * An unreadable `DB_SSL_CA_PATH` or an empty CA is an error, not a fallback:
 * the operator asked for verification, so silently downgrading would be the
 * worst of both.
 */

import { readFileSync } from "node:fs";

export interface DbSslEnv {
  DB_SSL_CA?: string;
  DB_SSL_CA_PATH?: string;
}

export type DbSslOptions =
  | false
  | { readonly rejectUnauthorized: true; readonly ca: string; readonly servername?: string }
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
    throw new Error(
      "db-ssl: DB_SSL_CA is set but is neither a PEM certificate nor base64 of one",
    );
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
 * @param env - `DB_SSL_CA` / `DB_SSL_CA_PATH`
 * @param warn - where the one-per-process legacy warning goes
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
    const servername = hostOf(connectionString);
    return servername
      ? { rejectUnauthorized: true, ca, servername }
      : { rejectUnauthorized: true, ca };
  }

  if (!warnedOnce) {
    warnedOnce = true;
    warn?.(
      "[db-ssl] Postgres TLS is encrypted but NOT verified: neither DB_SSL_CA nor DB_SSL_CA_PATH is set, so the server certificate is not checked (rejectUnauthorized: false). Provision the database CA and set one of them.",
      { host: hostOf(connectionString) },
    );
  }
  return { rejectUnauthorized: false };
}
