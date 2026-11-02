// Pure helpers over a parsed package-lock.json (lockfileVersion 2 or 3).
//
// Shared by the three supply-chain checks. Nothing here reads a file, the
// network or the clock: callers parse the JSON and pass the object in, so every
// check is a plain function of its inputs and testable against a small inline
// lockfile.

/** The only registry this repo's lockfile may resolve from. */
export const REGISTRY_ORIGIN = "https://registry.npmjs.org";
export const REGISTRY_PREFIX = `${REGISTRY_ORIGIN}/`;

/**
 * Whether `resolved` is a tarball URL on the public npm registry.
 *
 * Two independent tests must both pass. The string prefix is the plain rule
 * ("starts with https://registry.npmjs.org/"); the WHATWG parse closes the
 * cases a prefix test cannot see (embedded credentials, an unexpected port)
 * and a parse failure is a reject, never a pass.
 */
export function isPublicRegistryUrl(resolved) {
  if (typeof resolved !== "string" || !resolved.startsWith(REGISTRY_PREFIX)) {
    return false;
  }
  let url;
  try {
    url = new URL(resolved);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "registry.npmjs.org" &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

/** `node_modules/a/node_modules/@s/b` -> `@s/b`; null when there is no such segment. */
export function nameFromPath(path) {
  const marker = "node_modules/";
  const i = path.lastIndexOf(marker);
  return i === -1 ? null : path.slice(i + marker.length);
}

/**
 * Every non-root entry of the lockfile's `packages` map, normalised.
 *
 * Throws on a shape this tool does not understand (notably lockfileVersion 1,
 * which has no `packages` map): a check that silently saw zero packages would
 * pass on exactly the file it cannot read.
 *
 * `name` prefers the entry's own `name` (set for `npm:` aliases), then the
 * path, then the path itself (workspace source directories).
 */
export function listPackages(lock) {
  if (
    typeof lock !== "object" ||
    lock === null ||
    typeof lock.packages !== "object" ||
    lock.packages === null ||
    Array.isArray(lock.packages)
  ) {
    throw new Error("unsupported lockfile: no `packages` map (lockfileVersion 2 or 3 required)");
  }
  const out = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") continue;
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`malformed lockfile entry: ${path}`);
    }
    out.push({
      path,
      name: typeof entry.name === "string" ? entry.name : (nameFromPath(path) ?? path),
      version: typeof entry.version === "string" ? entry.version : null,
      isLink: entry.link === true,
      entry,
    });
  }
  return out;
}
