/**
 * Redact a database connection string for logs and error messages.
 *
 * Why this exists: the connection manager used to log
 * `connectionString.substring(0, 50)` as a "preview". A libpq URI puts the
 * password right after the user name — `postgresql://user:PASSWORD@host/…` —
 * so the first 50 characters of a real production string are the user name
 * and the first ten-odd characters of the password, URL-encoded. Observed
 * live on a deployed api pod's boot log (2026-09-05). A prefix of a secret
 * is not a redaction; it is a head start.
 *
 * The result keeps everything an operator needs to recognise which database
 * a pool points at — scheme, user, host, port, database name — and nothing
 * that could authenticate: the password is replaced by `***` and the query
 * string is dropped entirely (libpq accepts `?password=` there too, and
 * `sslrootcert`/`options` are not worth the exposure).
 *
 * Non-parseable input gets a fixed placeholder rather than any slice of the
 * original: a string that is not a URL is exactly the case where we cannot
 * tell which part is the secret.
 */

const REDACTED_PASSWORD = "***";
const UNPARSEABLE = "<connection string: not a URL, redacted>";

export function redactConnectionString(raw: string | undefined | null): string {
  if (typeof raw !== "string" || raw.length === 0) return "<connection string: unset>";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return UNPARSEABLE;
  }

  // WHATWG URL parses `postgresql://` as a non-special scheme; the authority
  // (user, password, host, port) and pathname are still separated for us.
  // Anything without an authority (`postgresql:foo`) cannot be a libpq URI we
  // want to describe, so treat it as unparseable rather than echo it.
  if (!url.host) return UNPARSEABLE;

  const user = url.username ? decodeURIComponentSafe(url.username) : "";
  const credential = url.username
    ? `${user}${url.password ? `:${REDACTED_PASSWORD}` : ""}@`
    : "";
  const path = url.pathname && url.pathname !== "/" ? url.pathname : "";

  return `${url.protocol}//${credential}${url.host}${path}`;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
