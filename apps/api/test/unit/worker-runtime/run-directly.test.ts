import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isRunDirectly } from "../../../../worker/src/run-directly.js";

const dir = mkdtempSync(join(tmpdir(), "run-directly-"));
mkdirSync(join(dir, "a"));
mkdirSync(join(dir, "b"));
const fileA = join(dir, "a", "main.js");
const fileB = join(dir, "b", "main.js");
const link = join(dir, "link.js");
writeFileSync(fileA, "");
writeFileSync(fileB, "");
symlinkSync(fileA, link);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("isRunDirectly (W14)", () => {
  const url = pathToFileURL(fileA).href;
  it("same file -> true", () => expect(isRunDirectly(url, fileA)).toBe(true));
  it("different file, same basename -> false", () =>
    expect(isRunDirectly(url, fileB)).toBe(false));
  it("symlink to the file -> true", () => expect(isRunDirectly(url, link)).toBe(true));
  it("argv[1] undefined -> false", () => expect(isRunDirectly(url, undefined)).toBe(false));
  it("nonexistent argv[1] -> false", () =>
    expect(isRunDirectly(url, join(dir, "nope.js"))).toBe(false));
});
