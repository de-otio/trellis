/**
 * Pure functional-core builder for ffmpeg argument arrays.
 *
 * Produces an argv ARRAY passed directly to the ffmpeg process — NEVER a shell
 * string. No interpolation into a shell context means no command injection risk
 * regardless of what inputPath / outputPath / posterPath contain.
 *
 * Hardening applied unconditionally on every invocation:
 *   - "-protocol_whitelist","file,pipe"   blocks SSRF (no http/https/rtmp/etc.)
 *   - "-t", String(maxDurationSeconds)    bounds processing time (from spec; never a literal)
 *   - "-dn"                               drop data tracks
 *   - "-sn"                               drop subtitle tracks
 *
 * Video additionally gets:
 *   - "-c:v","libx264","-c:a","aac"       re-encode to safe codecs
 *   - "-movflags","+faststart"            progressive streaming
 *
 * Audio-only gets:
 *   - "-c:a","aac"                        re-encode to safe codec
 *
 * Poster frame extraction is a SEPARATE argv (buildPosterArgs). Splitting the
 * two operations keeps the main transcode deterministic and lets the poster be
 * produced in a separate process without retranscoding. The poster job uses
 * "-frames:v","1" to extract exactly one frame and inherits all hardening args.
 *
 * PURITY: no I/O, no AWS SDK, no fs, no Date.now, no Math.random. All
 * operational parameters (maxDurationSeconds) arrive as function arguments
 * sourced from Env.media — never as literals in this file. Ships in the PUBLIC
 * npm tarball: no hard-coded operational numbers here.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Specification for a single ffmpeg transcode job.
 *
 * - `kind`               — "video" or "audio"; controls codec flags
 * - `inputPath`          — absolute path to the source file (read-only)
 * - `outputPath`         — absolute path for the transcoded output
 * - `posterPath`         — if set, {@link buildPosterArgs} targets this path
 * - `maxDurationSeconds` — duration cap sourced from Env.media; passed to -t
 */
export interface FfmpegJobSpec {
  readonly kind: "video" | "audio";
  readonly inputPath: string;
  readonly outputPath: string;
  readonly posterPath?: string;
  readonly maxDurationSeconds: number;
}

// ---------------------------------------------------------------------------
// buildFfmpegArgs
// ---------------------------------------------------------------------------

/**
 * Build the argv for transcoding a media object.
 *
 * The returned array is passed to the child-process launcher directly — never
 * joined into a shell string. The caller is responsible for prepending the
 * ffmpeg binary path or using `execFile`/`spawn` with `shell: false`.
 *
 * The protocol whitelist, duration cap, and track-drop flags are always present
 * in the output regardless of kind. The caller should verify these are present
 * before launching (the test suite does so exhaustively).
 */
export function buildFfmpegArgs(spec: FfmpegJobSpec): string[] {
  const args: string[] = [
    // SSRF prevention: accept only file: and pipe: protocols. This blocks any
    // attempt to use the ffmpeg process to reach http/https/rtmp/concat/subfile
    // endpoints that an in-VPC worker could reach.
    "-protocol_whitelist",
    "file,pipe",

    // Duration cap: sourced from spec (Env.media), never a compiled literal.
    "-t",
    String(spec.maxDurationSeconds),

    // Input
    "-i",
    spec.inputPath,

    // Drop data tracks (camera metadata, GPS, etc.) and subtitle tracks.
    // Neither is needed for the re-encoded output and both can carry payloads.
    "-dn",
    "-sn",
  ];

  if (spec.kind === "video") {
    args.push(
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      // Enable progressive download (moov atom first in the container).
      "-movflags",
      "+faststart",
    );
  } else {
    // audio-only
    args.push("-c:a", "aac");
  }

  // Overwrite output without prompt — required for non-interactive subprocess.
  args.push("-y", spec.outputPath);

  return args;
}

// ---------------------------------------------------------------------------
// buildPosterArgs
// ---------------------------------------------------------------------------

/**
 * Build the argv for extracting a poster frame from a video.
 *
 * This is a SEPARATE invocation from {@link buildFfmpegArgs}: splitting the two
 * means the transcode and the poster extraction run independently, the poster
 * can be regenerated without retranscoding, and the transcode argv stays clean.
 *
 * The poster job inherits all hardening (protocol whitelist, duration cap,
 * track drops) and adds:
 *   - "-frames:v","1"   — extract exactly one video frame
 *   - "-an"             — no audio output (image output only)
 *
 * Callers should only invoke this when `spec.posterPath` is defined. The
 * function documents this contract via its signature: if posterPath is absent,
 * the output path would be undefined and the caller must guard before spawning.
 * The implementation always uses spec.posterPath so TypeScript callers can call
 * with a spec that has posterPath set and get a well-formed array.
 *
 * @param spec - must have `posterPath` set; calling without it is a caller
 *               contract violation (outputPath would be undefined).
 */
export function buildPosterArgs(
  spec: FfmpegJobSpec & { readonly posterPath: string },
): string[] {
  return [
    "-protocol_whitelist",
    "file,pipe",

    "-t",
    String(spec.maxDurationSeconds),

    "-i",
    spec.inputPath,

    "-dn",
    "-sn",

    // Extract exactly one video frame.
    "-frames:v",
    "1",

    // No audio stream in the poster image output.
    "-an",

    "-y",
    spec.posterPath,
  ];
}
