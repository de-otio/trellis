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
 *   - "-dn"                               drop data STREAMS
 *   - "-sn"                               drop subtitle streams
 *   - "-map_metadata","-1"                drop the container metadata DICTIONARY
 *
 * `-dn` and `-map_metadata -1` are NOT the same control, and the difference was a
 * live privacy gap. `-dn` drops data *streams*; it does nothing to the container's
 * metadata dictionary, which is where MP4 actually keeps `©xyz` GPS coordinates
 * (`location`), `comment`, `title` and friends. ffmpeg COPIES that dictionary
 * input-to-output by default, so before `-map_metadata -1` a video kept its GPS
 * coordinates through the "strip" while the image path was busy removing exactly
 * that. Verified empirically against ffmpeg 8.1 with the production argv:
 * `location=+50.0000+008.0000/` and `comment` both survived; with
 * `-map_metadata -1` only the structural brands (`major_brand`, `minor_version`,
 * `compatible_brands`, `encoder`) remain.
 *
 * That makes the video path consistent with the image re-encode, and consistent
 * with the data-minimization rule in
 * doc/02-technical/surveillance-threat-model/07-data-minimization.md.
 *
 * CONSEQUENCE FOR AI ACT ART. 50: this strip destroys provenance markings too. An
 * XMP `uuid` box carrying `Iptc4xmpExt:DigitalSourceType` does NOT survive the
 * transcode (verified: present in the input bytes, absent from the output). So a
 * video's provenance MUST be read from the ORIGINAL bytes before this runs — the
 * same read-then-strip ordering the image path uses. See
 * lib/metadata/provenance-reader.ts and the worker's pre-transcode read.
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

    // Drop data STREAMS and subtitle streams. Neither is needed for the
    // re-encoded output and both can carry payloads.
    "-dn",
    "-sn",

    // Drop the container metadata DICTIONARY — this is a SEPARATE control from
    // -dn, and omitting it leaked GPS. See the module header for the empirical
    // result. Also destroys AI-provenance markings, which is why provenance is
    // read from the original bytes before the transcode.
    "-map_metadata",
    "-1",
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
// ---------------------------------------------------------------------------
// buildFrameSamplingArgs
// ---------------------------------------------------------------------------

/**
 * Specification for a frame-sampling job — the extraction that lets an
 * image-only classifier moderate video.
 *
 * `framesPerSecond` and `maxFrames` are OPERATOR-SUPPLIED and arrive as
 * arguments, never as literals: a sampling rate compiled into a public tarball
 * is a published sampling rate, and someone who knows the rate knows how long a
 * frame may survive unseen. `maxFrames` is additionally a hard resource bound —
 * it caps paid classifier calls and temp files per job independently of what
 * rate × duration would ask for.
 */
export interface FrameSamplingSpec {
  readonly inputPath: string;
  /**
   * Output PATTERN, not a directory: ffmpeg's image muxer writes a numbered
   * sequence, so this must contain a printf-style index (e.g. `.../frame-%04d.jpg`).
   */
  readonly outputPattern: string;
  readonly framesPerSecond: number;
  readonly maxFrames: number;
  readonly maxDurationSeconds: number;
}

/**
 * Build the argv for extracting still frames from a video.
 *
 * Inherits every hardening flag the transcode uses, for the same reasons, plus:
 *   - "-an"                    no audio in an image output
 *   - "-vf","fps=<rate>"       sample at the operator's rate
 *   - "-frames:v","<max>"      HARD ceiling, enforced by ffmpeg itself as well
 *                              as by the caller — belt and braces, because the
 *                              consequence of an unbounded frame count is a
 *                              filled disk and an unbounded provider bill.
 *
 * `-map_metadata -1` matters twice over here: a sampled frame is a derivative
 * of user media, and without the strip ffmpeg would copy the source container's
 * dictionary (GPS included) onto every extracted still — re-creating on dozens
 * of thumbnails exactly the leak the transcode path removes from the video.
 */
export function buildFrameSamplingArgs(spec: FrameSamplingSpec): string[] {
  return [
    "-protocol_whitelist",
    "file,pipe",

    "-t",
    String(spec.maxDurationSeconds),

    "-i",
    spec.inputPath,

    "-dn",
    "-sn",

    "-map_metadata",
    "-1",

    // No audio stream in an image output.
    "-an",

    // Sample at the operator-supplied rate.
    "-vf",
    `fps=${spec.framesPerSecond}`,

    // Absolute ceiling on emitted frames.
    "-frames:v",
    String(spec.maxFrames),

    "-y",
    spec.outputPattern,
  ];
}

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

    // The poster is an IMAGE derived from the video, so it inherits the same
    // metadata-dictionary strip. Without this, ffmpeg would copy the source's
    // tags (incl. GPS) onto the poster — a strip on the video and a leak on the
    // thumbnail is the worst of both.
    "-map_metadata",
    "-1",

    // Extract exactly one video frame.
    "-frames:v",
    "1",

    // No audio stream in the poster image output.
    "-an",

    "-y",
    spec.posterPath,
  ];
}
