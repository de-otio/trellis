/**
 * EXIF Stripping Utility
 *
 * PREPARATORY CHANGE: This utility is created now but not yet used in production.
 * It will be enabled when implementing location safety features for at-risk users.
 *
 * Removes EXIF data from images for privacy.
 * Can be enabled/disabled via configuration.
 *
 * FUTURE USE:
 * - When EXIF_STRIPPING_ENABLED=true, this utility will strip EXIF data from
 *   uploaded images before storing them
 * - Prevents location data, device info, and timestamps from being embedded in images
 * - Helps protect user privacy, especially for at-risk users
 */

export interface EXIFStripperConfig {
  enabled: boolean;
  removeLocation: boolean; // Remove GPS coordinates
  removeDeviceInfo: boolean; // Remove camera/device information
  removeTimestamp: boolean; // Remove creation timestamp
}

/**
 * Strip EXIF data from image buffer
 *
 * FUTURE USE: This function will be called during media upload processing
 * to remove EXIF data from images before storing them in R2.
 *
 * NOTE: This is currently a placeholder implementation.
 * When implementing, use a library like 'piexifjs' or 'exifr' to actually
 * remove EXIF data from the image buffer.
 *
 * @param imageBuffer - Image buffer to process
 * @param config - Stripping configuration
 * @returns Processed image buffer (with EXIF removed if enabled)
 */
export async function stripEXIF(
  imageBuffer: ArrayBuffer,
  config: EXIFStripperConfig = {
    enabled: true,
    removeLocation: true,
    removeDeviceInfo: true,
    removeTimestamp: false, // Keep timestamp for now (can be enabled later)
  },
): Promise<ArrayBuffer> {
  if (!config.enabled) {
    return imageBuffer;
  }

  // TODO: Implement actual EXIF stripping using a library
  // FUTURE IMPLEMENTATION:
  // 1. Install library: npm install piexifjs or npm install exifr
  // 2. Parse EXIF data from image buffer
  // 3. Remove location data if removeLocation=true
  // 4. Remove device info if removeDeviceInfo=true
  // 5. Remove timestamp if removeTimestamp=true
  // 6. Reconstruct image buffer without EXIF data
  //
  // Example with piexifjs:
  // import piexif from 'piexifjs';
  // const exifObj = piexif.load(imageBuffer);
  // if (config.removeLocation) delete exifObj['GPS'];
  // if (config.removeDeviceInfo) delete exifObj['0th'][piexif.ImageIFD.Make];
  // const newBuffer = piexif.dump(exifObj);
  // return newBuffer;

  // For now, return buffer as-is (no breaking changes)
  // This allows the utility to exist and be called without affecting current behavior
  return imageBuffer;
}
