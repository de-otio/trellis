// I/O layer for T4's public-type snapshots: invokes `tsc --emitDeclarationOnly`
// into a scratch directory and reads the result back into memory for the pure
// `snapshot-concat.mjs` logic to process. Not unit-tested directly (it shells
// out to the real TypeScript compiler) — the pure functions it feeds are.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

/**
 * Recursively collect every file under `dir`, returning POSIX-style paths
 * relative to `dir`.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listFilesRecursive(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  if (statSync(dir).isDirectory()) walk(dir);
  return out;
}

/**
 * Run `tsc -p <tsconfigPath> --emitDeclarationOnly` into a fresh temp
 * directory and return every emitted file's contents, keyed by path relative
 * to the declarations root (POSIX separators).
 *
 * @param {string} tscBinPath - path to the tsc executable
 * @param {string} tsconfigPath
 * @returns {{ filesByRelPath: Record<string, string>, stderr: string }}
 */
export function emitDeclarations(tscBinPath, tsconfigPath) {
  const outDir = mkdtempSync(join(tmpdir(), "trellis-api-snapshot-"));
  try {
    const result = spawnSync(
      tscBinPath,
      [
        "-p",
        tsconfigPath,
        "--emitDeclarationOnly",
        "--outDir",
        outDir,
        "--declarationMap",
        "false",
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(
        `tsc --emitDeclarationOnly failed for ${tsconfigPath} (exit ${result.status}):\n` +
          `${result.stdout ?? ""}${result.stderr ?? ""}`,
      );
    }
    const relPaths = listFilesRecursive(outDir).filter((p) =>
      p.endsWith(".d.ts"),
    );
    /** @type {Record<string, string>} */
    const filesByRelPath = {};
    for (const relPath of relPaths) {
      filesByRelPath[relPath] = readFileSync(join(outDir, relPath), "utf8");
    }
    return { filesByRelPath, stderr: result.stderr ?? "" };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
