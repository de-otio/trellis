# Media Metadata Data Model

> The Prisma schema lives in the trellis core (`prisma/schema.prisma`). Schema concepts and field definitions are design references.

**Purpose:** Define database schema changes and metadata field definitions for storing EXIF, IPTC, and video metadata.

---

## Metadata Types

This specification supports three types of metadata:

1. **EXIF** (images): Camera settings, date/time, GPS location - **Highest Priority**
2. **Video Metadata**: Date/time taken, technical information - **High Priority**
3. **IPTC** (images): Keywords, copyright, captions - **Medium Priority**

---

## EXIF Data Fields

### Core Fields to Extract

#### Camera/Device Information

- **Make** (string): Camera manufacturer (e.g., "Canon", "Apple", "Samsung")
- **Model** (string): Camera model (e.g., "Canon EOS 5D Mark IV", "iPhone 14 Pro")
- **Software** (string): Software used to process the image
- **Orientation** (number): Image orientation (1-8, standard EXIF orientation values)

#### Camera Settings (for photos taken with cameras)

- **ISO** (number): ISO sensitivity (e.g., 100, 400, 1600)
- **Aperture** (number): F-number (e.g., 2.8, 5.6, 11)
- **Shutter Speed** (string): Exposure time (e.g., "1/125", "1/2000", "2")
- **Focal Length** (number): Lens focal length in mm (e.g., 24, 50, 200)
- **Flash** (boolean): Whether flash was used
- **White Balance** (string): White balance mode (e.g., "Auto", "Daylight", "Tungsten")

#### Date and Time

- **DateTimeOriginal** (ISO 8601 string): Date and time when photo was taken
- **DateTimeDigitized** (ISO 8601 string): Date and time when photo was digitized

#### Location (GPS) - **Privacy Sensitive**

- **GPSLatitude** (number): Latitude in decimal degrees
- **GPSLongitude** (number): Longitude in decimal degrees
- **GPSAltitude** (number): Altitude in meters (optional)
- **GPSLocation** (string): Human-readable location (optional, reverse geocoded)

#### Image Properties

- **ColorSpace** (string): Color space (e.g., "sRGB", "Adobe RGB")
- **Resolution** (object): `{ width: number, height: number }` - Original resolution
- **XResolution** (number): Horizontal resolution in DPI
- **YResolution** (number): Vertical resolution in DPI

### Optional/Advanced Fields

- **ExposureMode** (string): Exposure mode (e.g., "Auto", "Manual", "Aperture Priority")
- **MeteringMode** (string): Metering mode (e.g., "Average", "Spot", "Center-weighted")
- **LensModel** (string): Lens model name
- **Artist** (string): Photographer name (if embedded)
- **Copyright** (string): Copyright information (if embedded)

---

## IPTC Data Fields

### Core Fields to Extract

#### Keywords (for Content Discovery) - **High Priority**

- **Keywords** (string[]): Array of keywords/tags for content discovery
  - Used for search, recommendations, and content filtering
  - Can auto-populate hashtags or improve discovery algorithms

#### Copyright Information

- **Copyright** (string): Copyright notice
- **CopyrightOwner** (string): Copyright owner name
- **RightsUsageTerms** (string): Usage terms or license

#### Descriptive Metadata

- **Caption** (string): Image caption/description
- **Headline** (string): Headline or title
- **Description** (string): Detailed description

#### Creator Information

- **Creator** (string): Photographer/creator name
- **CreatorContact** (string): Contact information
- **Credit** (string): Credit line

### Priority Fields for Social Media

**High Priority:**

- **Keywords**: Essential for content discovery and search

**Medium Priority:**

- **Copyright**: Important for content creators
- **Caption**: Useful but app has its own caption system

**Low Priority:**

- Other IPTC fields (can be added later if needed)

---

## Video Metadata Fields

### Core Fields to Extract

#### Date and Time - **Highest Priority**

- **DateTimeOriginal** (ISO 8601 string): Date and time when video was recorded
- **DateTimeDigitized** (ISO 8601 string): Date and time when video was digitized

#### Location (GPS) - **Privacy Sensitive**

- **GPSLatitude** (number): Latitude in decimal degrees
- **GPSLongitude** (number): Longitude in decimal degrees
- **GPSAltitude** (number): Altitude in meters (optional)

#### Technical Information

- **Codec** (string): Video codec (e.g., "H.264", "H.265", "VP9")
- **FrameRate** (number): Frames per second
- **Bitrate** (number): Bitrate in bps
- **Duration** (number): Duration in seconds (already extracted, but can verify from metadata)

#### Device Information

- **Make** (string): Device manufacturer (e.g., "Apple", "Samsung")
- **Model** (string): Device model (e.g., "iPhone 14 Pro", "Galaxy S23")

### Priority Fields for Social Media

**Highest Priority:**

- **DateTimeOriginal**: Critical for chronological feeds

**High Priority:**

- **GPS location**: For location-based features

**Low Priority:**

- Technical codec/bitrate info (less user-facing)

---

## Database Schema Changes

### MediaFile Model Extension

Add EXIF data fields to the `MediaFile` model:

```prisma
model MediaFile {
  // ... existing fields ...

  // EXIF Data (images) - stored as JSON for flexibility
  exifData Json? @map("exif_data") // Full EXIF data as JSON object

  // IPTC Data (images) - stored as JSON
  iptcData Json? @map("iptc_data") // Full IPTC data as JSON object

  // Video Metadata - stored as JSON
  videoMetadata Json? @map("video_metadata") // Video metadata as JSON object

  // Denormalized fields for common queries (optional, for performance)
  // EXIF fields
  exifMake String? @map("exif_make")
  exifModel String? @map("exif_model")
  exifDateTimeOriginal DateTime? @map("exif_datetime_original")
  exifGpsLatitude Float? @map("exif_gps_latitude")
  exifGpsLongitude Float? @map("exif_gps_longitude")

  // IPTC fields (for search/discovery)
  iptcKeywords String[] @default([]) @map("iptc_keywords") // Array of keywords for search
  iptcCopyright String? @map("iptc_copyright")

  // Video metadata fields
  videoDateTimeOriginal DateTime? @map("video_datetime_original")
  videoGpsLatitude Float? @map("video_gps_latitude")
  videoGpsLongitude Float? @map("video_gps_longitude")

  // Privacy flags (binary toggles - for quick on/off)
  metadataVisible Boolean @default(true) @map("metadata_visible") // User preference for all metadata
  locationVisible Boolean @default(false) @map("location_visible") // Location privacy (applies to both EXIF and video)

  // Granular field-level visibility (JSON object for flexibility)
  // Allows users to select which specific metadata fields are visible to others
  metadataVisibilitySettings Json? @map("metadata_visibility_settings") // Field-level visibility controls

  // ... rest of existing fields ...
}
```

### Migration Strategy

1. **Add JSON field first** (non-breaking): Add `exifData`, `iptcData`, `videoMetadata` as nullable JSON fields
2. **Backfill existing media** (optional): Extract metadata from existing media on-demand
3. **Add denormalized fields** (optional): For performance-critical queries
4. **Add privacy flags** (optional): For user control (binary toggles)
5. **Add granular visibility settings** (optional): For field-level control (Phase 2 enhancement)

### Indexes

```sql
-- Index for filtering by camera make/model
CREATE INDEX idx_media_files_exif_make_model
ON media_files(exif_make, exif_model)
WHERE exif_make IS NOT NULL;

-- Index for date taken queries (EXIF)
CREATE INDEX idx_media_files_exif_datetime_original
ON media_files(exif_datetime_original)
WHERE exif_datetime_original IS NOT NULL;

-- Index for date taken queries (Video)
CREATE INDEX idx_media_files_video_datetime_original
ON media_files(video_datetime_original)
WHERE video_datetime_original IS NOT NULL;

-- Index for IPTC keywords (for content discovery)
CREATE INDEX idx_media_files_iptc_keywords
ON media_files USING GIN(iptc_keywords)
WHERE array_length(iptc_keywords, 1) > 0;

-- Index for combined date queries (EXIF or video)
-- Note: PostgreSQL can use both indexes in UNION queries
```

---

## Data Types

### Metadata Interfaces (TypeScript)

```typescript
export interface EXIFData {
  // Camera/Device
  Make?: string;
  Model?: string;
  Software?: string;
  Orientation?: number;

  // Camera Settings
  ISO?: number;
  FNumber?: number; // Aperture
  ExposureTime?: string; // Shutter speed
  FocalLength?: number;
  Flash?: boolean;
  WhiteBalance?: string;

  // Date/Time
  DateTimeOriginal?: string;
  DateTimeDigitized?: string;

  // Location
  GPSLatitude?: number;
  GPSLongitude?: number;
  GPSAltitude?: number;

  // Image Properties
  ColorSpace?: string;
  XResolution?: number;
  YResolution?: number;

  // Optional
  ExposureMode?: string;
  MeteringMode?: string;
  LensModel?: string;
  Artist?: string;
  Copyright?: string;
}

export interface IPTCData {
  // Keywords (High Priority for discovery)
  Keywords?: string[];

  // Copyright (Medium Priority)
  Copyright?: string;
  CopyrightOwner?: string;
  RightsUsageTerms?: string;

  // Descriptive (Lower Priority)
  Caption?: string;
  Headline?: string;
  Description?: string;

  // Creator (Lower Priority)
  Creator?: string;
  CreatorContact?: string;
  Credit?: string;
}

export interface VideoMetadata {
  // Date/Time (Highest Priority)
  DateTimeOriginal?: string;
  DateTimeDigitized?: string;

  // Location (High Priority)
  GPSLatitude?: number;
  GPSLongitude?: number;
  GPSAltitude?: number;

  // Technical (Lower Priority)
  Codec?: string;
  FrameRate?: number;
  Bitrate?: number;
  Duration?: number;

  // Device (Lower Priority)
  Make?: string;
  Model?: string;
}

// Granular visibility settings for field-level control
export interface MetadataVisibilitySettings {
  // EXIF field visibility
  exif?: {
    cameraInfo?: boolean; // Make, Model, Software
    cameraSettings?: boolean; // ISO, Aperture, Shutter Speed, Focal Length, Flash, White Balance
    dateTime?: boolean; // DateTimeOriginal, DateTimeDigitized
    location?: boolean; // GPS coordinates (overrides locationVisible if set)
    imageProperties?: boolean; // ColorSpace, Resolution
    advanced?: boolean; // ExposureMode, MeteringMode, LensModel, Artist, Copyright
  };

  // IPTC field visibility
  iptc?: {
    keywords?: boolean; // Keywords array
    copyright?: boolean; // Copyright, CopyrightOwner, RightsUsageTerms
    descriptive?: boolean; // Caption, Headline, Description
    creator?: boolean; // Creator, CreatorContact, Credit
  };

  // Video metadata visibility
  video?: {
    dateTime?: boolean; // DateTimeOriginal, DateTimeDigitized
    location?: boolean; // GPS coordinates (overrides locationVisible if set)
    technical?: boolean; // Codec, FrameRate, Bitrate, Duration
    device?: boolean; // Make, Model
  };
}
```

---

## Storage Considerations

### JSON Field

- **Flexibility**: Can store any EXIF fields without schema changes
- **Size**: Typically 1-5KB per media file
- **Query Performance**: Slower for filtering/searching (use denormalized fields)

### Denormalized Fields

- **Performance**: Fast queries on common fields (make, model, date)
- **Storage**: Additional columns, but minimal overhead
- **Maintenance**: Must keep in sync with JSON field

### Trade-offs

- **Storage vs. Performance**: JSON is flexible but slower for queries
- **Schema Evolution**: JSON allows adding fields without migrations
- **Query Optimization**: Denormalized fields enable indexed queries
