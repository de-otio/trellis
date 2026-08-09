/**
 * Enforces one invariant: runtime code does not construct `S3Client` directly.
 *
 * Why a source scan rather than a behavioural test. `new S3Client({ region })`
 * is not wrong in isolation — it is wrong *off-AWS*, and the failure is silent.
 * The SDK reads a single ambient AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY pair
 * for every service, so on a platform where that pair belongs to the queue
 * service, a directly-built S3 client is authenticated as the wrong principal
 * and every call 403s. No type error, no failing unit test — the call site is
 * usually inside a `catch` that treats the failure as "nothing to do".
 *
 * `createDefaultS3Client()` resolves the storage-specific credential pair and
 * the endpoint, so it is the only sanctioned construction path. The worker
 * bootstrap that motivated this rule has no test harness of its own, so this
 * scan is what keeps the fix from silently regressing.
 *
 * `src/lambda/**` is exempt: those modules run only on AWS Lambda (no non-lambda
 * importers), where the ambient pair genuinely is the right credential.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const SCANNED_ROOTS = [
  join(repoRoot, "apps", "api", "src"),
  join(repoRoot, "apps", "worker", "src"),
];

/** Lambda-only code; see the header note. */
const EXEMPT_DIRS = new Set(["lambda", "node_modules", "dist"]);

/**
 * Comments are stripped before matching. Without this the rule trips on any
 * doc-comment that *names* the forbidden construction — including the ones
 * explaining why it is forbidden — and a rule that fires on prose is a rule
 * people switch off.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function collectTypeScriptSources(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXEMPT_DIRS.has(entry.name)) continue;
      found.push(...collectTypeScriptSources(join(dir, entry.name)));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

describe("S3 client construction", () => {
  const sources = SCANNED_ROOTS.flatMap((root) => collectTypeScriptSources(root));

  it("scans a non-empty set of sources", () => {
    // Guards the guard: a broken path would make every assertion below vacuous.
    expect(sources.length).toBeGreaterThan(100);
  });

  it("never constructs S3Client directly outside src/lambda", () => {
    const offenders = sources
      .filter((file) => /\bnew\s+S3Client\s*\(/.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => relative(repoRoot, file));

    expect(
      offenders,
      `Use createDefaultS3Client() from @de-otio/saas-foundation/storage instead. ` +
        `A directly-built S3Client inherits the ambient AWS_* credential pair, ` +
        `which off-AWS belongs to another service.`,
    ).toEqual([]);
  });

  it("builds the worker's purge client through the factory", () => {
    const workerMain = readFileSync(
      join(repoRoot, "apps", "worker", "src", "main.ts"),
      "utf8",
    );

    expect(workerMain).toContain("createDefaultS3Client");
  });
});
