// The network edge for the provenance check: one version manifest from the
// public npm registry.
//
// The host is fixed. The package name and version come from a lockfile that a
// pull request controls, so both are validated before they reach a URL, and
// redirects are refused so a response can never steer the request elsewhere.
// The user's npm config (registry, auth) is deliberately not consulted.

import { REGISTRY_ORIGIN } from "./lockfile.mjs";

// Legacy packages can have upper-case names; the character set is otherwise npm's.
const NAME = /^(@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;
const VERSION = /^[0-9A-Za-z.+-]+$/;

const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;
/** A version manifest is a few KB; anything near this is not one. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tooLarge(what) {
  return Object.assign(new Error(`registry response too large (${what})`), { permanent: true });
}

/** Parse a JSON body, refusing more than MAX_BODY_BYTES, by header and while reading. */
async function readJsonCapped(res) {
  const declared = Number(res.headers?.get?.("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw tooLarge(`content-length ${declared}`);

  if (!res.body?.getReader) {
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw tooLarge("body");
    return JSON.parse(text);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge("body");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Fetch `https://registry.npmjs.org/<name>/<version>`.
 * Resolves to the parsed manifest, or null on 404. Rejects on invalid input
 * and on any other failure after a few attempts. Rejection is deliberate: a
 * registry we cannot reach is not evidence that provenance is intact.
 */
export async function fetchVersionMeta(name, version, fetchImpl = fetch) {
  if (!NAME.test(name) || name.length > 214) {
    throw new Error(`refusing to look up package with odd name: ${name}`);
  }
  if (!VERSION.test(version) || version.length > 128) {
    throw new Error(`refusing to look up odd version: ${name}@${version}`);
  }
  const url = `${REGISTRY_ORIGIN}/${name.replaceAll("/", "%2F")}/${encodeURIComponent(version)}`;

  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await readJsonCapped(res);
    } catch (err) {
      lastError = err;
      if (err.permanent) break;
      if (attempt < ATTEMPTS) await sleep(500 * attempt);
    }
  }
  throw new Error(`registry lookup failed for ${name}@${version}: ${lastError.message}`);
}
