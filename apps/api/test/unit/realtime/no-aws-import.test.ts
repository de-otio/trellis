/**
 * The no-AWS-in-core tripwire (frozen contract §2 hard constraint + L1).
 *
 * Scans every source file under `src/lib/realtime/` and asserts NONE imports an
 * AWS SDK (`aws-sdk`, `@aws-sdk/...`), `aws-appsync`, `aws-amplify`, or `amplify`.
 * A negative fixture (`_fixtures/aws-import-violation.fixture.ts`) deliberately
 * imports an AWS SDK; the test asserts the SAME scanner flags it — so the test
 * fails loudly if the scanner is ever weakened.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const realtimeDir = join(here, "../../../src/lib/realtime");
const fixtureFile = join(here, "_fixtures/aws-import-violation.fixture.ts");

/** Matches imports/requires of an AWS SDK, AppSync, or Amplify. */
const FORBIDDEN =
  /\b(?:import|require)\b[^;\n]*['"](?:aws-sdk|@aws-sdk\/|aws-appsync|aws-amplify|@aws-amplify\/|amplify)[^'"]*['"]/;

/** Recursively collect all .ts files under a directory. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** True if the given file source imports a forbidden AWS/AppSync/Amplify module. */
function importsForbidden(source: string): boolean {
  return source
    .split("\n")
    .some((line) => FORBIDDEN.test(line));
}

describe("no-aws-import invariant (realtime/ must stay AWS-free)", () => {
  it("scans at least the expected realtime modules", () => {
    const files = tsFilesUnder(realtimeDir);
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it("no file under src/lib/realtime imports an AWS SDK / AppSync / Amplify", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(realtimeDir)) {
      const source = readFileSync(file, "utf8");
      if (importsForbidden(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("the scanner FIRES on the negative fixture (proves the rule works)", () => {
    const source = readFileSync(fixtureFile, "utf8");
    expect(importsForbidden(source)).toBe(true);
  });

  it("the scanner regex flags representative forbidden imports", () => {
    const samples = [
      `import { DynamoDBClient } from "@aws-sdk/client-dynamodb";`,
      `import AWS from "aws-sdk";`,
      `import { AWSAppSyncClient } from "aws-appsync";`,
      `const { Amplify } = require("aws-amplify");`,
      `import { events } from "@aws-amplify/data";`,
    ];
    for (const s of samples) {
      expect(FORBIDDEN.test(s)).toBe(true);
    }
  });

  it("the scanner does NOT flag benign imports", () => {
    const benign = [
      `import type { NotificationType } from "@prisma/client";`,
      `import { channelFor } from "./channel.js";`,
      `import { z } from "zod";`,
    ];
    for (const s of benign) {
      expect(FORBIDDEN.test(s)).toBe(false);
    }
  });
});
