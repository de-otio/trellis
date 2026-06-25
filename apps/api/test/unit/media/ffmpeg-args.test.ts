/**
 * Property + example tests for the ffmpeg-args pure functional-core unit.
 *
 * Obligations tested:
 *   - Output ALWAYS contains the file,pipe protocol whitelist entry.
 *   - Output ALWAYS contains the -t cap equal to spec.maxDurationSeconds.
 *   - Output ALWAYS contains -dn and -sn (track drops).
 *   - Output NEVER contains http, https, rtmp, concat, or subfile in the
 *     protocol_whitelist value.
 *   - The cap value TRACKS the spec (varying maxDurationSeconds yields a
 *     different -t argument).
 *   - Video output contains libx264, aac, and +faststart.
 *   - Audio output contains aac and does NOT contain libx264 or +faststart.
 *   - The output and input paths appear as arguments (correct wiring).
 *   - buildPosterArgs: always contains -frames:v / 1, -an, same hardening.
 *   - No shell-metacharacter injection: malicious paths never break the array
 *     structure (no join happens — the property confirms path values appear
 *     verbatim without splitting).
 *   - Output is always a non-empty string array (never undefined items).
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  buildFfmpegArgs,
  buildPosterArgs,
  type FfmpegJobSpec,
} from "../../../src/lib/media/ffmpeg-args";

// Seed fast-check for determinism.
const FC = { seed: 0xffaa, numRuns: 800 } as const;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const kindArb: fc.Arbitrary<"video" | "audio"> = fc.constantFrom(
  "video",
  "audio",
);

// Positive finite numbers for duration cap (realistic range + edge cases).
// fc.float requires 32-bit float bounds — use Math.fround to satisfy the constraint.
const durationArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: 7200 }),
  fc.float({
    min: Math.fround(0.001),
    max: Math.fround(3600),
    noNaN: true,
    noDefaultInfinity: true,
  }),
);

// Arbitrary path strings — including characters that would be dangerous in a
// shell context (spaces, semicolons, backticks, dollar signs). These must
// appear verbatim in the array without splitting.
const pathArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant("/media/input.mp4"),
  fc.constant("/media/output.mp4"),
  // Paths with shell metacharacters that would cause injection if joined.
  fc.string({ minLength: 1, maxLength: 80 }).map((s) => `/safe/${s}`),
);

const specArb: fc.Arbitrary<FfmpegJobSpec> = fc.record({
  kind: kindArb,
  inputPath: pathArb,
  outputPath: pathArb,
  maxDurationSeconds: durationArb,
});

const specWithPosterArb: fc.Arbitrary<FfmpegJobSpec & { posterPath: string }> =
  fc.record({
    kind: kindArb,
    inputPath: pathArb,
    outputPath: pathArb,
    posterPath: pathArb,
    maxDurationSeconds: durationArb,
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the value of the argument that follows `flag` in an argv array.
 * Returns undefined if the flag is absent.
 */
function argAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

/**
 * Count how many times `value` appears in the array as a standalone element.
 */
function countFlag(args: string[], value: string): number {
  return args.filter((a) => a === value).length;
}

// ---------------------------------------------------------------------------
// buildFfmpegArgs — properties
// ---------------------------------------------------------------------------

describe("buildFfmpegArgs", () => {
  // Property: protocol_whitelist is always present and equals "file,pipe"
  it("always includes -protocol_whitelist file,pipe", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const args = buildFfmpegArgs(spec);
        const whitelist = argAfter(args, "-protocol_whitelist");
        expect(whitelist).toBe("file,pipe");
      }),
      FC,
    );
  });

  // Property: protocol whitelist value NEVER contains dangerous protocols
  it("protocol whitelist never contains http, https, rtmp, concat, or subfile", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const args = buildFfmpegArgs(spec);
        const whitelist = argAfter(args, "-protocol_whitelist") ?? "";
        const protocols = whitelist.split(",");
        expect(protocols).not.toContain("http");
        expect(protocols).not.toContain("https");
        expect(protocols).not.toContain("rtmp");
        expect(protocols).not.toContain("concat");
        expect(protocols).not.toContain("subfile");
      }),
      FC,
    );
  });

  // Property: -t cap is always present and exactly equals spec.maxDurationSeconds
  it("always includes -t equal to spec.maxDurationSeconds", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const args = buildFfmpegArgs(spec);
        const cap = argAfter(args, "-t");
        expect(cap).toBe(String(spec.maxDurationSeconds));
      }),
      FC,
    );
  });

  // Property: cap TRACKS the spec — different durations yield different -t values
  it("-t value tracks spec.maxDurationSeconds (varying the cap changes the arg)", () => {
    fc.assert(
      fc.property(
        specArb,
        fc.integer({ min: 1, max: 7200 }),
        (spec, altDuration) => {
          fc.pre(spec.maxDurationSeconds !== altDuration);
          const args1 = buildFfmpegArgs(spec);
          const args2 = buildFfmpegArgs({ ...spec, maxDurationSeconds: altDuration });
          const cap1 = argAfter(args1, "-t");
          const cap2 = argAfter(args2, "-t");
          expect(cap1).not.toBe(cap2);
        },
      ),
      FC,
    );
  });

  // Property: -dn is always present (data track drop)
  it("always includes -dn", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const args = buildFfmpegArgs(spec);
        expect(args).toContain("-dn");
      }),
      FC,
    );
  });

  // Property: -sn is always present (subtitle track drop)
  it("always includes -sn", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const args = buildFfmpegArgs(spec);
        expect(args).toContain("-sn");
      }),
      FC,
    );
  });

  // Property: output is a string array with no undefined/null items
  it("returns a non-empty string array with no undefined items", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const args = buildFfmpegArgs(spec);
        expect(Array.isArray(args)).toBe(true);
        expect(args.length).toBeGreaterThan(0);
        for (const a of args) {
          expect(typeof a).toBe("string");
          expect(a).not.toBeUndefined();
        }
      }),
      FC,
    );
  });

  // Property: inputPath appears verbatim in the args (after -i)
  it("includes inputPath verbatim as the -i argument", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const args = buildFfmpegArgs(spec);
        expect(argAfter(args, "-i")).toBe(spec.inputPath);
      }),
      FC,
    );
  });

  // Property: outputPath appears verbatim as the last argument
  it("includes outputPath verbatim as the final argument", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const args = buildFfmpegArgs(spec);
        expect(args[args.length - 1]).toBe(spec.outputPath);
      }),
      FC,
    );
  });

  // Property: video always has libx264, aac, +faststart
  it("video: always includes libx264, aac, and +faststart", () => {
    fc.assert(
      fc.property(
        specArb.filter((s) => s.kind === "video"),
        (spec) => {
          const args = buildFfmpegArgs(spec);
          expect(argAfter(args, "-c:v")).toBe("libx264");
          expect(argAfter(args, "-c:a")).toBe("aac");
          expect(argAfter(args, "-movflags")).toBe("+faststart");
        },
      ),
      FC,
    );
  });

  // Property: audio-only never has libx264 or +faststart; has aac
  it("audio: includes aac but not libx264 or +faststart", () => {
    fc.assert(
      fc.property(
        specArb.filter((s) => s.kind === "audio"),
        (spec) => {
          const args = buildFfmpegArgs(spec);
          expect(argAfter(args, "-c:a")).toBe("aac");
          expect(args).not.toContain("libx264");
          expect(args).not.toContain("+faststart");
          expect(args).not.toContain("-movflags");
        },
      ),
      FC,
    );
  });

  // Property: no shell metacharacters in path values cause extra array entries
  // (the path is a single element, not split)
  it("shell-metacharacter paths appear as single array elements (no injection)", () => {
    const dangerousPaths = [
      "/safe/path; rm -rf /",
      "/safe/path$(echo injected)",
      "/safe/path`whoami`",
      "/safe/path & malicious",
      "/safe/path | tee /dev/null",
    ];
    for (const path of dangerousPaths) {
      const spec: FfmpegJobSpec = {
        kind: "video",
        inputPath: path,
        outputPath: "/output/out.mp4",
        maxDurationSeconds: 60,
      };
      const args = buildFfmpegArgs(spec);
      // The path must appear as a single, verbatim element
      const inputIdx = args.indexOf("-i");
      expect(inputIdx).toBeGreaterThanOrEqual(0);
      expect(args[inputIdx + 1]).toBe(path);
    }
  });

  // ---------------------------------------------------------------------------
  // Example-based tests for important edge cases
  // ---------------------------------------------------------------------------

  it("video example: correct full structure", () => {
    const spec: FfmpegJobSpec = {
      kind: "video",
      inputPath: "/upload/raw.mp4",
      outputPath: "/processed/clean.mp4",
      maxDurationSeconds: 300,
    };
    const args = buildFfmpegArgs(spec);
    expect(argAfter(args, "-protocol_whitelist")).toBe("file,pipe");
    expect(argAfter(args, "-t")).toBe("300");
    expect(argAfter(args, "-i")).toBe("/upload/raw.mp4");
    expect(args).toContain("-dn");
    expect(args).toContain("-sn");
    expect(argAfter(args, "-c:v")).toBe("libx264");
    expect(argAfter(args, "-c:a")).toBe("aac");
    expect(argAfter(args, "-movflags")).toBe("+faststart");
    expect(args[args.length - 1]).toBe("/processed/clean.mp4");
  });

  it("audio example: correct full structure", () => {
    const spec: FfmpegJobSpec = {
      kind: "audio",
      inputPath: "/upload/raw.ogg",
      outputPath: "/processed/clean.aac",
      maxDurationSeconds: 600,
    };
    const args = buildFfmpegArgs(spec);
    expect(argAfter(args, "-protocol_whitelist")).toBe("file,pipe");
    expect(argAfter(args, "-t")).toBe("600");
    expect(argAfter(args, "-i")).toBe("/upload/raw.ogg");
    expect(args).toContain("-dn");
    expect(args).toContain("-sn");
    expect(argAfter(args, "-c:a")).toBe("aac");
    expect(args).not.toContain("libx264");
    expect(args).not.toContain("-movflags");
    expect(args[args.length - 1]).toBe("/processed/clean.aac");
  });

  it("maxDurationSeconds: fractional values pass through as the correct string", () => {
    const spec: FfmpegJobSpec = {
      kind: "audio",
      inputPath: "/in.ogg",
      outputPath: "/out.aac",
      maxDurationSeconds: 0.5,
    };
    expect(argAfter(buildFfmpegArgs(spec), "-t")).toBe("0.5");
  });

  it("does not contain http in protocol whitelist for any kind", () => {
    const videoArgs = buildFfmpegArgs({
      kind: "video",
      inputPath: "/a",
      outputPath: "/b",
      maxDurationSeconds: 10,
    });
    const audioArgs = buildFfmpegArgs({
      kind: "audio",
      inputPath: "/a",
      outputPath: "/b",
      maxDurationSeconds: 10,
    });
    for (const args of [videoArgs, audioArgs]) {
      const whitelist = argAfter(args, "-protocol_whitelist") ?? "";
      expect(whitelist).not.toMatch(/https?/);
      expect(whitelist).not.toMatch(/rtmp/);
    }
  });
});

// ---------------------------------------------------------------------------
// buildPosterArgs — properties
// ---------------------------------------------------------------------------

describe("buildPosterArgs", () => {
  // Property: protocol_whitelist is always present and equals "file,pipe"
  it("always includes -protocol_whitelist file,pipe", () => {
    fc.assert(
      fc.property(specWithPosterArb, (spec) => {
        const args = buildPosterArgs(spec);
        expect(argAfter(args, "-protocol_whitelist")).toBe("file,pipe");
      }),
      FC,
    );
  });

  // Property: -t cap is always present and equals spec.maxDurationSeconds
  it("always includes -t equal to spec.maxDurationSeconds", () => {
    fc.assert(
      fc.property(specWithPosterArb, (spec) => {
        const args = buildPosterArgs(spec);
        expect(argAfter(args, "-t")).toBe(String(spec.maxDurationSeconds));
      }),
      FC,
    );
  });

  // Property: -dn always present
  it("always includes -dn", () => {
    fc.assert(
      fc.property(specWithPosterArb, (spec) => {
        expect(buildPosterArgs(spec)).toContain("-dn");
      }),
      FC,
    );
  });

  // Property: -sn always present
  it("always includes -sn", () => {
    fc.assert(
      fc.property(specWithPosterArb, (spec) => {
        expect(buildPosterArgs(spec)).toContain("-sn");
      }),
      FC,
    );
  });

  // Property: -frames:v 1 always present
  it("always includes -frames:v 1", () => {
    fc.assert(
      fc.property(specWithPosterArb, (spec) => {
        const args = buildPosterArgs(spec);
        expect(argAfter(args, "-frames:v")).toBe("1");
      }),
      FC,
    );
  });

  // Property: -an always present (no audio in poster image)
  it("always includes -an", () => {
    fc.assert(
      fc.property(specWithPosterArb, (spec) => {
        expect(buildPosterArgs(spec)).toContain("-an");
      }),
      FC,
    );
  });

  // Property: posterPath appears verbatim as the last argument
  it("includes posterPath verbatim as the final argument", () => {
    fc.assert(
      fc.property(specWithPosterArb, (spec) => {
        const args = buildPosterArgs(spec);
        expect(args[args.length - 1]).toBe(spec.posterPath);
      }),
      FC,
    );
  });

  // Property: inputPath appears verbatim after -i
  it("includes inputPath verbatim as the -i argument", () => {
    fc.assert(
      fc.property(specWithPosterArb, (spec) => {
        const args = buildPosterArgs(spec);
        expect(argAfter(args, "-i")).toBe(spec.inputPath);
      }),
      FC,
    );
  });

  // Property: protocol whitelist never contains dangerous protocols
  it("protocol whitelist never contains http, https, rtmp, concat, or subfile", () => {
    fc.assert(
      fc.property(specWithPosterArb, (spec) => {
        const args = buildPosterArgs(spec);
        const whitelist = argAfter(args, "-protocol_whitelist") ?? "";
        const protocols = whitelist.split(",");
        expect(protocols).not.toContain("http");
        expect(protocols).not.toContain("https");
        expect(protocols).not.toContain("rtmp");
        expect(protocols).not.toContain("concat");
        expect(protocols).not.toContain("subfile");
      }),
      FC,
    );
  });

  // Property: poster args don't contain libx264 or +faststart (image output only)
  it("does not include video transcode flags (libx264, +faststart)", () => {
    fc.assert(
      fc.property(specWithPosterArb, (spec) => {
        const args = buildPosterArgs(spec);
        expect(args).not.toContain("libx264");
        expect(args).not.toContain("+faststart");
      }),
      FC,
    );
  });

  // Property: cap tracks the spec
  it("-t value tracks spec.maxDurationSeconds", () => {
    fc.assert(
      fc.property(
        specWithPosterArb,
        fc.integer({ min: 1, max: 7200 }),
        (spec, altDuration) => {
          fc.pre(spec.maxDurationSeconds !== altDuration);
          const cap1 = argAfter(buildPosterArgs(spec), "-t");
          const cap2 = argAfter(
            buildPosterArgs({ ...spec, maxDurationSeconds: altDuration }),
            "-t",
          );
          expect(cap1).not.toBe(cap2);
        },
      ),
      FC,
    );
  });

  it("poster example: correct full structure", () => {
    const spec = {
      kind: "video" as const,
      inputPath: "/upload/raw.mp4",
      outputPath: "/processed/clean.mp4",
      posterPath: "/processed/poster.jpg",
      maxDurationSeconds: 120,
    };
    const args = buildPosterArgs(spec);
    expect(argAfter(args, "-protocol_whitelist")).toBe("file,pipe");
    expect(argAfter(args, "-t")).toBe("120");
    expect(argAfter(args, "-i")).toBe("/upload/raw.mp4");
    expect(args).toContain("-dn");
    expect(args).toContain("-sn");
    expect(argAfter(args, "-frames:v")).toBe("1");
    expect(args).toContain("-an");
    expect(args[args.length - 1]).toBe("/processed/poster.jpg");
    // Must not contain the transcode output path
    expect(args).not.toContain("/processed/clean.mp4");
  });

  // Tautology guard: confirm tests would catch a bad implementation
  it("would FAIL if -protocol_whitelist were omitted (tautology guard)", () => {
    // We simulate a bad impl that drops the whitelist and confirm our detection logic works.
    const spec = {
      kind: "video" as const,
      inputPath: "/a",
      outputPath: "/b",
      posterPath: "/c",
      maxDurationSeconds: 30,
    };
    const goodArgs = buildPosterArgs(spec);
    const badArgs = goodArgs.filter((a) => a !== "-protocol_whitelist" && a !== "file,pipe");
    // The detection: argAfter on the bad array returns undefined
    expect(argAfter(badArgs, "-protocol_whitelist")).toBeUndefined();
    // The good args pass
    expect(argAfter(goodArgs, "-protocol_whitelist")).toBe("file,pipe");
  });
});

// ---------------------------------------------------------------------------
// Cross-concerns: buildFfmpegArgs and buildPosterArgs are independent
// ---------------------------------------------------------------------------

describe("buildFfmpegArgs vs buildPosterArgs independence", () => {
  it("transcode output does not appear in poster args and vice versa", () => {
    const spec = {
      kind: "video" as const,
      inputPath: "/in/video.mov",
      outputPath: "/out/transcode.mp4",
      posterPath: "/out/poster.jpg",
      maxDurationSeconds: 90,
    };
    const transcodeArgs = buildFfmpegArgs(spec);
    const posterArgs = buildPosterArgs(spec);

    // Transcode final output is the outputPath
    expect(transcodeArgs[transcodeArgs.length - 1]).toBe(spec.outputPath);
    // Poster final output is the posterPath
    expect(posterArgs[posterArgs.length - 1]).toBe(spec.posterPath);
    // Cross-check: poster path is not the last arg of transcode
    expect(transcodeArgs[transcodeArgs.length - 1]).not.toBe(spec.posterPath);
    // Cross-check: transcode output path doesn't appear in poster args
    // (they don't share an output)
    expect(posterArgs).not.toContain(spec.outputPath);
  });

  it("both produce the same protocol whitelist and hardening flags", () => {
    const spec = {
      kind: "audio" as const,
      inputPath: "/in/audio.flac",
      outputPath: "/out/audio.aac",
      posterPath: "/out/poster.jpg",
      maxDurationSeconds: 200,
    };
    const transcodeArgs = buildFfmpegArgs(spec);
    const posterArgs = buildPosterArgs(spec);

    for (const args of [transcodeArgs, posterArgs]) {
      expect(argAfter(args, "-protocol_whitelist")).toBe("file,pipe");
      expect(argAfter(args, "-t")).toBe("200");
      expect(args).toContain("-dn");
      expect(args).toContain("-sn");
    }
  });
});
