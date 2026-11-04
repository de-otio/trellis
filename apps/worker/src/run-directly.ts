/**
 * run-directly.ts — "was this module the process entry point?" (W14).
 *
 * Compares full resolved paths, not basenames: an unrelated entry file that
 * happens to share a basename must not match, and a symlinked path to this
 * file must. Both sides go through `realpath`.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isRunDirectly(
  moduleUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (argv1 === undefined || argv1 === "") return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    // Unresolvable path (missing file, non-file URL): not a direct run.
    return false;
  }
}
