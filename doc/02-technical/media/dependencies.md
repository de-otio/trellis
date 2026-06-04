# EXIF Data Dependencies

**Purpose:** Define required packages, system dependencies, and compatibility requirements.

---

## NPM Packages

### Required

```json
{
  "dependencies": {
    "exifr": "^7.1.3"
  }
}
```

**Package:** `exifr`  
**Version:** ^7.1.3  
**Purpose:** EXIF, IPTC, and video metadata extraction  
**License:** MIT  
**Size:** ~50KB (minified)  
**Compatibility:** Pure-JS / runs in any standard Node.js or edge runtime

**Features:**

- EXIF data extraction from JPEG/TIFF images
- IPTC data extraction from JPEG/TIFF images
- Video metadata extraction from QuickTime/MOV files
- Single library for all metadata types

**Installation:**

```bash
cd apps/api
npm install exifr
```

---

## Database

### PostgreSQL

- **JSON Field Support**: Required (already available in PostgreSQL)
- **JSONB Support**: Optional (for better query performance, if needed)
- **Migration Support**: Prisma migrations

### Schema Changes

- Add `exifData` JSON field (nullable)
- Add denormalized fields (optional, for performance)
- Add privacy flag fields
- Add indexes for common queries

---

## Frontend

The consuming application supplies the frontend; the metadata display is client-agnostic.

- **No new backend-side frontend dependencies required**
- Reuse the consuming app's existing media widgets and date-formatting utilities

---

## System Requirements

### Runtime

- **Runtime**: Node.js (the reference deployment runs the API as a long-lived server)
- **Memory**: Sufficient for EXIF extraction (~50MB per extraction)
- **CPU Time**: < 100ms per extraction (target)

### Storage

- **Object storage**: For storing original images (S3 or compatible)
- **Database**: For storing EXIF metadata (PostgreSQL)
- **KV / cache**: Optional, for caching (if needed)

---

## Compatibility

### Image Formats

- **JPEG**: Full EXIF support ✅
- **TIFF**: Full EXIF support ✅
- **PNG**: No EXIF support ❌
- **WebP**: Limited EXIF support ⚠️
- **GIF**: No EXIF support ❌
- **HEIC/HEIF**: EXIF support (if converted to JPEG) ⚠️

### Browser/Device Support

- **iOS**: EXIF data preserved in JPEG uploads ✅
- **Android**: EXIF data preserved in JPEG uploads ✅
- **Web**: EXIF data preserved if not stripped by browser ✅

---

## Version Compatibility

### Node.js

- **Minimum**: Node.js 18+
- **Recommended**: Node.js 22+

### TypeScript

- **Minimum**: TypeScript 5.0+
- **Recommended**: Latest stable version

### Prisma

- **Version**: 5.x (current)
- **Compatibility**: JSON fields supported

---

## External Services

### None Required

- No external APIs needed for basic EXIF extraction
- No third-party services required

### Optional (Future)

- **Geocoding API**: For reverse geocoding (Google Maps, Mapbox)
- **Analytics Service**: For EXIF statistics (optional)

---

## Development Dependencies

### Testing

- **Vitest**: Already in project
- **Test Images**: Need sample images with EXIF data

### Build Tools

- **TypeScript**: Already configured

---

## Security Considerations

### Package Security

- **exifr**: Regularly updated, MIT license
- **Audit**: Run `npm audit` regularly
- **Updates**: Keep package updated for security patches

### Data Validation

- Validate EXIF data structure
- Sanitize string fields
- Validate GPS coordinates

---

## Performance Considerations

### Package Size

- **exifr**: ~50KB minified
- **Impact**: Minimal on bundle size
- **Tree-shaking**: Supported

### Runtime Performance

- **Extraction Time**: < 100ms per image (target)
- **Memory Usage**: ~50MB per extraction
- **CPU Usage**: Minimal

---

## Migration Path

### From Current State

1. **Install package**: `npm install exifr`
2. **Add to code**: Import and use EXIFExtractor
3. **Database migration**: Add EXIF fields
4. **Deploy**: No breaking changes

### Rollback

- Remove EXIF extraction code
- EXIF fields are nullable (no data loss)
- Migration can be rolled back

---

## Documentation

### Package Documentation

- **exifr**: https://mutiny.github.io/exifr/
- **API Reference**: See package README

### Internal Documentation

- This specification
- Code comments
- API documentation

---

## Support and Maintenance

### Package Maintenance

- **exifr**: Actively maintained
- **Updates**: Check for updates quarterly
- **Issues**: Report to package maintainer if needed

### Internal Maintenance

- Monitor extraction success rate
- Track performance metrics
- Update as needed for new EXIF standards
