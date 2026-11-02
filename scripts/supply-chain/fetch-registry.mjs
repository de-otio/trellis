// The network edge for the provenance check: one version manifest from the
// public npm registry.
//
// The host is fixed. The package name and version come from a lockfile that a
// pull request controls, so both are validated before they reach a URL, and
// redirects are refused so a response can never steer the request elsewhere.
// The user's npm config (registry, auth) is deliberately not consulted.

import { REGISTRY_ORIGIN } from "./lockfile.mjs";

const NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const VERSION = /^[0-9A-Za-z.+-]+$/;

const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const url = `${REGISTRY_ORIGIN}/${name.replace("/", "%2F")}/${encodeURIComponent(version)}`;

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
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < ATTEMPTS) await sleep(500 * attempt);
    }
  }
  throw new Error(`registry lookup failed for ${name}@${version}: ${lastError.message}`);
}
