import exifr from "exifr";

import { getLogger, Logger, type LoggerEnv } from "../logger.js";
import { METADATA_LIMITS } from "./metadata-config.js";
import {
  MetadataExtractionError,
  MetadataValidationError,
} from "./metadata-errors.js";
import {
  sanitizeString,
  validateDate,
  validateGPS,
  validateKeywords,
  validateMetadataSize,
} from "./metadata-sanitizer.js";
import {
  EXIFDataSchema,
  IPTCDataSchema,
  VideoMetadataSchema,
} from "./metadata-schemas.js";

export type ExtractedMetadata = {
  exifData?: unknown;
  iptcData?: unknown;
  videoMetadata?: unknown;
};

export class MetadataExtractor {
  private logger: Logger;

  constructor(env?: LoggerEnv) {
    this.logger = env ? getLogger() : ({} as Logger);
  }

  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_, reject) => {
      timerId = setTimeout(() => {
        reject(
          new MetadataExtractionError(
            `Metadata extraction timed out: ${label}`,
            { code: "timeout" },
          ),
        );
      }, METADATA_LIMITS.EXTRACTION_TIMEOUT_MS);
    });

    return Promise.race([
      p.finally(() => {
        if (timerId) clearTimeout(timerId);
      }),
      timeout,
    ]);
  }

  private toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
    return input instanceof Uint8Array ? input : new Uint8Array(input);
  }

  async extractAll(
    input: ArrayBuffer | Uint8Array,
    mimeType: string,
  ): Promise<ExtractedMetadata> {
    const start = Date.now();

    // Pre size check (raw bytes) – avoid massive files passed by mistake.
    // We don't reject large uploads here; upload pipeline should enforce. This is defensive.
    if (this.toBytes(input).byteLength === 0) return {};

    const tasks: Array<Promise<void>> = [];
    const out: ExtractedMetadata = {};

    if (mimeType.startsWith("image/")) {
      tasks.push(
        this.withTimeout(this.extractEXIF(input), "exif").then((v) => {
          if (v) out.exifData = v;
        }),
      );
      tasks.push(
        this.withTimeout(this.extractIPTC(input), "iptc").then((v) => {
          if (v) out.iptcData = v;
        }),
      );
    } else if (mimeType.startsWith("video/")) {
      tasks.push(
        this.withTimeout(this.extractVideo(input, mimeType), "video").then(
          (v) => {
            if (v) out.videoMetadata = v;
          },
        ),
      );
    } else {
      throw new MetadataExtractionError(
        "Unsupported mime type for metadata extraction",
        {
          code: "unsupported_mime",
        },
      );
    }

    const results = await Promise.allSettled(tasks);
    const duration = Date.now() - start;

    const failures = results.filter(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult[];
    if (failures.length) {
      // Log only high-level info; never raw metadata
      this.logger.warn(
        "[MetadataExtractor] Partial metadata extraction failure",
        {
          duration,
          mimeType,
          failureCount: failures.length,
          failures: failures.map((f) => ({
            name: (f.reason as any)?.name,
            code: (f.reason as any)?.code,
            message: (f.reason as any)?.message,
          })),
        },
      );
    } else {
      this.logger.info("[MetadataExtractor] Metadata extracted", {
        duration,
        mimeType,
        hasExif: Boolean(out.exifData),
        hasIptc: Boolean(out.iptcData),
        hasVideo: Boolean(out.videoMetadata),
      });
    }

    return out;
  }

  private async extractEXIF(input: ArrayBuffer | Uint8Array) {
    try {
      const bytes = this.toBytes(input);
      const exif: any = await exifr.parse(bytes.buffer, {
        // Best-effort minimal fields; exifr is capable of more.
        // Keep GPS extraction but we will sanitize.
        pick: [
          "Make",
          "Model",
          "LensModel",
          "Software",
          "ISO",
          "FNumber",
          "ExposureTime",
          "FocalLength",
          "DateTimeOriginal",
          "latitude",
          "longitude",
        ],
        tiff: true,
        exif: true,
        gps: true,
      });

      if (!exif || typeof exif !== "object") return undefined;

      const gps = validateGPS(exif.latitude, exif.longitude);
      const dateTimeOriginal = validateDate(exif.DateTimeOriginal);

      const sanitized = {
        make: sanitizeString(exif.Make),
        model: sanitizeString(exif.Model),
        lensModel: sanitizeString(exif.LensModel),
        software: sanitizeString(exif.Software),
        iso:
          typeof exif.ISO === "number" && Number.isFinite(exif.ISO)
            ? Math.trunc(exif.ISO)
            : undefined,
        fNumber:
          typeof exif.FNumber === "number" && Number.isFinite(exif.FNumber)
            ? exif.FNumber
            : undefined,
        exposureTime:
          typeof exif.ExposureTime === "number" &&
          Number.isFinite(exif.ExposureTime)
            ? exif.ExposureTime
            : undefined,
        focalLength:
          typeof exif.FocalLength === "number" &&
          Number.isFinite(exif.FocalLength)
            ? exif.FocalLength
            : undefined,
        dateTimeOriginal,
        gps,
      };

      const parsed = EXIFDataSchema.safeParse(sanitized);
      if (!parsed.success) {
        throw new MetadataValidationError("EXIF validation failed", {
          issues: parsed.error.flatten(),
        });
      }

      validateMetadataSize(parsed.data);
      return parsed.data;
    } catch (e) {
      if (e instanceof MetadataValidationError) throw e;
      if (e instanceof MetadataExtractionError) throw e;
      throw new MetadataExtractionError("EXIF extraction failed", {
        code: "extraction_failed",
        cause: e,
      });
    }
  }

  private async extractIPTC(input: ArrayBuffer | Uint8Array) {
    try {
      const bytes = this.toBytes(input);
      // exifr supports IPTC via parse w/ iptc: true
      const iptc: any = await exifr.parse(bytes.buffer, {
        iptc: true,
        pick: ["Keywords", "CopyrightNotice", "Creator", "Caption/Abstract"],
      });

      if (!iptc || typeof iptc !== "object") return undefined;

      const sanitized = {
        keywords: validateKeywords(iptc.Keywords),
        copyrightNotice: sanitizeString(iptc.CopyrightNotice),
        creator: sanitizeString(iptc.Creator),
        caption: sanitizeString(iptc["Caption/Abstract"]),
      };

      const parsed = IPTCDataSchema.safeParse(sanitized);
      if (!parsed.success) {
        throw new MetadataValidationError("IPTC validation failed", {
          issues: parsed.error.flatten(),
        });
      }

      validateMetadataSize(parsed.data);
      return parsed.data;
    } catch (e) {
      if (e instanceof MetadataValidationError) throw e;
      if (e instanceof MetadataExtractionError) throw e;
      throw new MetadataExtractionError("IPTC extraction failed", {
        code: "extraction_failed",
        cause: e,
      });
    }
  }

  private async extractVideo(
    input: ArrayBuffer | Uint8Array,
    mimeType: string,
  ) {
    // Workers-friendly: we currently only provide basic fields from header parser.
    // More advanced video metadata (GPS/date) usually requires heavier parsing.
    try {
      const { MediaMetadataExtractor } = await import(
        "../media-metadata-extractor.js"
      );
      const extractor = new MediaMetadataExtractor();
      const basic = await extractor.extractMetadata(input, mimeType);

      const sanitized = {
        width: typeof basic.width === "number" ? basic.width : undefined,
        height: typeof basic.height === "number" ? basic.height : undefined,
        duration:
          typeof basic.duration === "number" ? basic.duration : undefined,
      };

      const parsed = VideoMetadataSchema.safeParse(sanitized);
      if (!parsed.success) {
        throw new MetadataValidationError("Video metadata validation failed", {
          issues: parsed.error.flatten(),
        });
      }

      validateMetadataSize(parsed.data);
      return parsed.data;
    } catch (e) {
      if (e instanceof MetadataValidationError) throw e;
      if (e instanceof MetadataExtractionError) throw e;
      throw new MetadataExtractionError("Video metadata extraction failed", {
        code: "extraction_failed",
        cause: e,
      });
    }
  }
}
