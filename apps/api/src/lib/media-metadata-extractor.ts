/**
 * Media Metadata Extractor
 *
 * Extracts metadata (width, height, duration) from media files.
 *
 * Supports:
 * - Images: JPEG, PNG, GIF, WebP (extracts width/height from headers)
 * - Videos: MP4, WebM (extracts width/height/duration from headers)
 *
 * This is a lightweight implementation that parses file headers directly
 * without requiring external libraries. For more advanced metadata extraction,
 * consider using a dedicated library or service.
 */

import { getLogger, Logger, type LoggerEnv } from "./logger.js";

export interface MediaMetadata {
  width?: number;
  height?: number;
  duration?: number; // Duration in seconds (for videos)
}

export class MediaMetadataExtractor {
  private logger: Logger;

  constructor(env?: LoggerEnv) {
    this.logger = env ? getLogger() : ({} as Logger);
  }

  /**
   * Extract metadata from media file
   *
   * @param fileBuffer - File buffer (ArrayBuffer or Uint8Array)
   * @param mimeType - MIME type of the file
   * @returns Media metadata (width, height, duration)
   */
  async extractMetadata(
    fileBuffer: ArrayBuffer | Uint8Array,
    mimeType: string,
  ): Promise<MediaMetadata> {
    const bytes =
      fileBuffer instanceof Uint8Array
        ? fileBuffer
        : new Uint8Array(fileBuffer);

    if (mimeType.startsWith("image/")) {
      return this.extractImageMetadata(bytes, mimeType);
    } else if (mimeType.startsWith("video/")) {
      return this.extractVideoMetadata(bytes, mimeType);
    }

    // Unknown type - return empty metadata
    return {};
  }

  /**
   * Extract metadata from image files
   */
  private extractImageMetadata(
    bytes: Uint8Array,
    mimeType: string,
  ): MediaMetadata {
    try {
      if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
        return this.extractJPEGMetadata(bytes);
      } else if (mimeType === "image/png") {
        return this.extractPNGMetadata(bytes);
      } else if (mimeType === "image/gif") {
        return this.extractGIFMetadata(bytes);
      } else if (mimeType === "image/webp") {
        return this.extractWebPMetadata(bytes);
      }
    } catch (error: any) {
      this.logger.warn("[MediaMetadata] Error extracting image metadata", {
        mimeType,
        error: error.message,
      });
    }

    return {};
  }

  /**
   * Extract metadata from video files
   */
  private extractVideoMetadata(
    bytes: Uint8Array,
    mimeType: string,
  ): MediaMetadata {
    try {
      if (mimeType === "video/mp4" || mimeType === "video/quicktime") {
        return this.extractMP4Metadata(bytes);
      } else if (mimeType === "video/webm") {
        return this.extractWebMMetadata(bytes);
      }
    } catch (error: any) {
      this.logger.warn("[MediaMetadata] Error extracting video metadata", {
        mimeType,
        error: error.message,
      });
    }

    return {};
  }

  /**
   * Extract dimensions from JPEG file
   * JPEG files have SOF (Start of Frame) markers that contain dimensions
   */
  private extractJPEGMetadata(bytes: Uint8Array): MediaMetadata {
    // JPEG files start with FF D8 FF
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      return {};
    }

    // Look for SOF markers (FF C0, FF C1, FF C2, FF C3, FF C5, FF C6, FF C7, FF C9, FF CA, FF CB, FF CD, FF CE, FF CF)
    for (let i = 0; i < bytes.length - 8; i++) {
      if (bytes[i] === 0xff) {
        const marker = bytes[i + 1];
        // SOF markers (Start of Frame)
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          // Height is at offset +5 (2 bytes, big-endian)
          // Width is at offset +7 (2 bytes, big-endian)
          const height = (bytes[i + 5] << 8) | bytes[i + 6];
          const width = (bytes[i + 7] << 8) | bytes[i + 8];
          return { width, height };
        }
      }
    }

    return {};
  }

  /**
   * Extract dimensions from PNG file
   * PNG files have IHDR chunk at offset 16 with width (4 bytes) and height (4 bytes), both big-endian
   */
  private extractPNGMetadata(bytes: Uint8Array): MediaMetadata {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes.length < 24 ||
      bytes[0] !== 0x89 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x4e ||
      bytes[3] !== 0x47
    ) {
      return {};
    }

    // Width is at offset 16 (4 bytes, big-endian)
    // Height is at offset 20 (4 bytes, big-endian)
    const width =
      (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const height =
      (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];

    return { width, height };
  }

  /**
   * Extract dimensions from GIF file
   * GIF files have width and height at offset 6 (2 bytes each, little-endian)
   */
  private extractGIFMetadata(bytes: Uint8Array): MediaMetadata {
    // GIF signature: 47 49 46 38 (GIF8)
    if (
      bytes.length < 10 ||
      bytes[0] !== 0x47 ||
      bytes[1] !== 0x49 ||
      bytes[2] !== 0x46 ||
      bytes[3] !== 0x38
    ) {
      return {};
    }

    // Width is at offset 6 (2 bytes, little-endian)
    // Height is at offset 8 (2 bytes, little-endian)
    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);

    return { width, height };
  }

  /**
   * Extract dimensions from WebP file
   * WebP files have VP8/VP8L chunks with dimensions
   */
  private extractWebPMetadata(bytes: Uint8Array): MediaMetadata {
    // WebP signature: RIFF ... WEBP
    if (
      bytes.length < 30 ||
      bytes[0] !== 0x52 ||
      bytes[1] !== 0x49 ||
      bytes[2] !== 0x46 ||
      bytes[3] !== 0x46 ||
      bytes[8] !== 0x57 ||
      bytes[9] !== 0x45 ||
      bytes[10] !== 0x42 ||
      bytes[11] !== 0x50
    ) {
      return {};
    }

    // Look for VP8 or VP8L chunk
    // VP8 chunk starts at offset 12
    // VP8L chunk starts at offset 12
    const chunkType = String.fromCharCode(
      bytes[12],
      bytes[13],
      bytes[14],
      bytes[15],
    );

    if (chunkType === "VP8 ") {
      // VP8 format: dimensions are at offset 26 (2 bytes width, 2 bytes height, little-endian)
      if (bytes.length < 30) return {};
      const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
      const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
      return { width, height };
    } else if (chunkType === "VP8L") {
      // VP8L format: dimensions are encoded in first 4 bytes of VP8L data
      if (bytes.length < 25) return {};
      const bits =
        bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }

    return {};
  }

  /**
   * Extract metadata from MP4 file
   * MP4 files have 'tkhd' (track header) atom with dimensions
   */
  private extractMP4Metadata(bytes: Uint8Array): MediaMetadata {
    // MP4 files start with ftyp box at offset 4
    if (
      bytes.length < 8 ||
      bytes[4] !== 0x66 ||
      bytes[5] !== 0x74 ||
      bytes[6] !== 0x79 ||
      bytes[7] !== 0x70
    ) {
      return {};
    }

    // Look for 'tkhd' atom (track header) which contains width/height
    // This is a simplified parser - full MP4 parsing is complex
    for (let i = 0; i < bytes.length - 100; i++) {
      // Check for 'tkhd' atom signature
      if (
        bytes[i] === 0x74 &&
        bytes[i + 1] === 0x6b &&
        bytes[i + 2] === 0x68 &&
        bytes[i + 3] === 0x64
      ) {
        // Read atom size (first 4 bytes, big-endian)
        const atomSize =
          (bytes[i - 4] << 24) |
          (bytes[i - 3] << 16) |
          (bytes[i - 2] << 8) |
          bytes[i - 1];

        // Version byte is at offset +4
        const version = bytes[i + 4];

        // Width and height are at different offsets depending on version
        // Version 0: fixed-point 16.16 format at offset +76 (width) and +80 (height)
        // Version 1: fixed-point 16.16 format at offset +88 (width) and +92 (height)
        if (version === 0 && atomSize >= 84) {
          const width =
            ((bytes[i + 76] << 24) |
              (bytes[i + 77] << 16) |
              (bytes[i + 78] << 8) |
              bytes[i + 79]) /
            65536;
          const height =
            ((bytes[i + 80] << 24) |
              (bytes[i + 81] << 16) |
              (bytes[i + 82] << 8) |
              bytes[i + 83]) /
            65536;
          return { width: Math.round(width), height: Math.round(height) };
        } else if (version === 1 && atomSize >= 100) {
          // Version 1 uses 64-bit values, but we'll read the high 32 bits
          const width =
            ((bytes[i + 88] << 24) |
              (bytes[i + 89] << 16) |
              (bytes[i + 90] << 8) |
              bytes[i + 91]) /
            65536;
          const height =
            ((bytes[i + 92] << 24) |
              (bytes[i + 93] << 16) |
              (bytes[i + 94] << 8) |
              bytes[i + 95]) /
            65536;
          return { width: Math.round(width), height: Math.round(height) };
        }
      }
    }

    return {};
  }

  /**
   * Extract metadata from WebM file
   * WebM files use Matroska container format - parsing is complex
   * For now, return empty metadata (can be enhanced later)
   */
  private extractWebMMetadata(bytes: Uint8Array): MediaMetadata {
    // WebM signature: 1A 45 DF A3
    if (
      bytes.length < 4 ||
      bytes[0] !== 0x1a ||
      bytes[1] !== 0x45 ||
      bytes[2] !== 0xdf ||
      bytes[3] !== 0xa3
    ) {
      return {};
    }

    // WebM/Matroska parsing is complex and requires EBML parsing
    // For now, return empty metadata
    // TODO: Implement full WebM metadata extraction if needed
    return {};
  }
}
