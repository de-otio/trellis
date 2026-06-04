# EXIF Data Testing Requirements

**Purpose:** Define unit, integration, and E2E test specifications for EXIF data support.

---

## Unit Tests

### Metadata Extraction Tests

**File:** `apps/api/test/unit/lib/metadata-extractor.test.ts`

#### EXIF Extraction Tests

1. **Test extraction from JPEG with EXIF**:
   - Load test image with known EXIF data
   - Extract EXIF data
   - Verify all expected fields are present
   - Verify values match expected data

2. **Test extraction from JPEG without EXIF**:
   - Load test image without EXIF
   - Extract EXIF data
   - Verify null is returned

3. **Test extraction from PNG (no EXIF support)**:
   - Load PNG image
   - Extract EXIF data
   - Verify null is returned

4. **Test handling of corrupted EXIF data**:
   - Load image with corrupted EXIF
   - Extract EXIF data
   - Verify graceful handling (returns null or partial data)

5. **Test formatting of shutter speed values**:
   - Test fractional speeds (1/125, 1/2000)
   - Test whole second speeds (2, 5)
   - Verify correct formatting

6. **Test date conversion**:
   - Verify DateTimeOriginal converted to ISO string
   - Verify DateTimeDigitized converted to ISO string

#### IPTC Extraction Tests

7. **Test extraction from JPEG with IPTC**:
   - Load test image with known IPTC data (keywords, copyright)
   - Extract IPTC data
   - Verify keywords array is populated
   - Verify copyright information present

8. **Test extraction from JPEG without IPTC**:
   - Load test image without IPTC
   - Extract IPTC data
   - Verify null is returned

9. **Test keywords normalization**:
   - Test single keyword (string) → converted to array
   - Test multiple keywords (array) → remains array
   - Test empty keywords → empty array

#### Video Metadata Extraction Tests

10. **Test extraction from QuickTime/MOV with metadata**:
    - Load video with known metadata
    - Extract video metadata
    - Verify date/time fields present
    - Verify GPS data if present

11. **Test extraction from MP4**:
    - Load MP4 video
    - Extract video metadata
    - Verify basic extraction or null (depending on format support)

12. **Test extraction from video without metadata**:
    - Load video without embedded metadata
    - Extract video metadata
    - Verify null is returned

13. **Test extraction from image (should return null)**:
    - Load image file
    - Extract video metadata
    - Verify null is returned

### API Endpoint Tests

**File:** `apps/api/test/unit/routes/media.test.ts`

1. **Test EXIF data in media details response**:
   - Mock media with EXIF data
   - Call GET /api/media/:mediaId
   - Verify EXIF data in response
   - Verify all expected fields present

2. **Test IPTC data in media details response**:
   - Mock media with IPTC data (keywords, copyright)
   - Call GET /api/media/:mediaId
   - Verify IPTC data in response
   - Verify keywords array present

3. **Test video metadata in media details response**:
   - Mock media with video metadata
   - Call GET /api/media/:mediaId
   - Verify video metadata in response
   - Verify date/time fields present

4. **Test unified dateTaken field**:
   - Mock media with EXIF dateTimeOriginal
   - Verify dateTaken = exifData.dateTimeOriginal
   - Mock media with video dateTimeOriginal (no EXIF)
   - Verify dateTaken = videoMetadata.dateTimeOriginal

5. **Test privacy controls (location hiding)**:
   - Mock media with GPS data (EXIF or video)
   - Set locationVisible=false
   - Call GET /api/media/:mediaId
   - Verify GPS data is not in response (for both EXIF and video)

6. **Test includeMetadata=false parameter**:
   - Mock media with all metadata types
   - Call GET /api/media/:mediaId?includeMetadata=false
   - Verify all metadata is null in response

7. **Test legacy includeExif parameter**:
   - Mock media with EXIF data
   - Call GET /api/media/:mediaId?includeExif=false
   - Verify metadata is null (backward compatibility)

8. **Test metadata visibility update endpoint**:
   - Call PATCH /api/media/:mediaId/metadata-visibility
   - Verify privacy settings updated
   - Verify response contains updated settings

9. **Test legacy exif-visibility endpoint**:
   - Call PATCH /api/media/:mediaId/exif-visibility
   - Verify maps to metadata-visibility
   - Verify backward compatibility

10. **Test unauthorized access**:
    - Call endpoints without authentication
    - Verify 401 Unauthorized response

11. **Test media ownership**:
    - Call endpoints for media owned by different user
    - Verify 403 Forbidden response

### Database Tests

**File:** `apps/api/test/unit/lib/media-handler.test.ts`

1. **Test EXIF data storage**:
   - Create media with EXIF data
   - Verify EXIF data stored in database
   - Verify denormalized fields populated

2. **Test IPTC data storage**:
   - Create media with IPTC data
   - Verify IPTC data stored in database
   - Verify keywords array stored correctly
   - Verify denormalized keywords field populated

3. **Test video metadata storage**:
   - Create media with video metadata
   - Verify video metadata stored in database
   - Verify denormalized date fields populated

4. **Test metadata retrieval**:
   - Query media with all metadata types
   - Verify all metadata retrieved correctly
   - Verify JSON parsing works for all types

5. **Test privacy flag defaults**:
   - Create media without setting privacy flags
   - Verify defaults applied (metadataVisible=true, locationVisible=false)

6. **Test privacy flag updates**:
   - Update privacy flags
   - Verify changes persisted
   - Verify flags affect API responses (EXIF, IPTC, video)

7. **Test keywords array indexing**:
   - Create media with IPTC keywords
   - Query media by keyword
   - Verify GIN index works correctly

---

## Integration Tests

### Upload Flow Tests

**File:** `apps/api/test/integration/media-upload.test.ts`

1. **Upload image with EXIF and IPTC → verify extraction**:
   - Upload JPEG with known EXIF and IPTC data
   - Verify EXIF data extracted
   - Verify IPTC data extracted
   - Verify both stored in database
   - Verify both in media details response

2. **Upload image with only EXIF → verify extraction**:
   - Upload JPEG with EXIF but no IPTC
   - Verify EXIF extracted, IPTC is null
   - Verify upload succeeds

3. **Upload image with only IPTC → verify extraction**:
   - Upload JPEG with IPTC but no EXIF
   - Verify IPTC extracted, EXIF is null
   - Verify upload succeeds

4. **Upload image without metadata → verify graceful handling**:
   - Upload JPEG without EXIF or IPTC
   - Verify upload succeeds
   - Verify metadata is null in database
   - Verify no errors logged

5. **Upload video with metadata → verify extraction**:
   - Upload QuickTime/MOV with metadata
   - Verify video metadata extracted
   - Verify stored in database
   - Verify in media details response

6. **Upload video without metadata → verify graceful handling**:
   - Upload video without embedded metadata
   - Verify upload succeeds
   - Verify videoMetadata is null

7. **Upload with corrupted metadata → verify graceful handling**:
   - Upload image with corrupted EXIF
   - Verify upload succeeds
   - Verify no EXIF data stored (but IPTC may still work)
   - Verify warning logged

### Media Details Tests

**File:** `apps/api/test/integration/media-details.test.ts`

1. **Request media with all metadata → verify display**:
   - Get media details for media with EXIF, IPTC, and video metadata
   - Verify all metadata types in response
   - Verify all expected fields present

2. **Request image with EXIF and IPTC → verify display**:
   - Get media details for image with both metadata types
   - Verify EXIF and IPTC data in response
   - Verify keywords array present

3. **Request video with metadata → verify display**:
   - Get media details for video with metadata
   - Verify video metadata in response
   - Verify dateTaken field populated

4. **Toggle metadata visibility → verify response changes**:
   - Update metadataVisible to false
   - Get media details
   - Verify all metadata is null

5. **Toggle location visibility → verify GPS data shown/hidden**:
   - Update locationVisible to true
   - Get media details
   - Verify GPS data in response (EXIF or video)
   - Update locationVisible to false
   - Get media details
   - Verify GPS data not in response (for both EXIF and video)

6. **Test includeMetadata parameter**:
   - Get media details with includeMetadata=true
   - Verify all metadata included
   - Get media details with includeMetadata=false
   - Verify all metadata excluded

7. **Test legacy includeExif parameter**:
   - Get media details with includeExif=false
   - Verify all metadata excluded (backward compatibility)

---

## E2E Tests

### User Flow Tests

**File:** `apps/flutter/test/e2e/media_metadata_test.dart`

1. **Upload photo with EXIF and IPTC → view details → see metadata**:
   - Upload image with EXIF and IPTC data
   - Navigate to media details page
   - Verify EXIF sections displayed
   - Verify IPTC keywords displayed as chips
   - Verify camera information shown
   - Verify camera settings shown

2. **Upload video with metadata → view details → see video metadata**:
   - Upload video with metadata
   - Navigate to media details page
   - Verify video metadata section displayed
   - Verify date taken shown
   - Verify technical info shown

3. **Toggle location visibility → see GPS coordinates appear/disappear**:
   - View media with GPS data (image or video)
   - Verify location not shown initially
   - Toggle location visibility on
   - Verify location appears
   - Toggle location visibility off
   - Verify location disappears

4. **Upload photo without metadata → see no metadata sections**:
   - Upload image without EXIF or IPTC
   - Navigate to media details page
   - Verify no metadata sections displayed
   - Verify message about no metadata

5. **Toggle metadata visibility → see metadata appear/disappear**:
   - View media with metadata
   - Toggle metadata visibility off
   - Verify all metadata sections hidden
   - Toggle metadata visibility on
   - Verify all metadata sections shown

6. **View IPTC keywords → verify display**:
   - View media with IPTC keywords
   - Verify keywords displayed as chips
   - Verify keywords are clickable (future: link to search)

---

## Test Data

### Test Images

1. **JPEG with full EXIF data**:
   - Camera: Canon EOS 5D Mark IV
   - ISO: 400
   - Aperture: f/2.8
   - Shutter Speed: 1/125
   - Focal Length: 50mm
   - GPS: San Francisco, CA

2. **JPEG with minimal EXIF**:
   - Only Make and Model
   - No camera settings
   - No GPS

3. **JPEG without EXIF**:
   - Stripped EXIF data
   - No metadata

4. **PNG image**:
   - No EXIF support
   - Should return null

5. **Corrupted EXIF**:
   - Invalid EXIF structure
   - Should handle gracefully

---

## Performance Tests

### Extraction Performance

1. **Test extraction time**:
   - Measure EXIF extraction time for various image sizes
   - Verify < 100ms for typical images (p95)
   - Test with large images (10MB+)

2. **Test database query performance**:
   - Measure query time with EXIF data
   - Verify < 10ms additional overhead (p95)
   - Test with denormalized fields

3. **Test API response time**:
   - Measure response time with EXIF data
   - Verify < 50ms additional overhead (p95)
   - Test with/without includeExif parameter

---

## Test Coverage Goals

- **Unit tests**: > 90% coverage for EXIF extraction
- **Integration tests**: Cover all upload and detail flows
- **E2E tests**: Cover main user flows
- **Edge cases**: Corrupted data, missing fields, privacy controls

---

## Test Maintenance

### Regular Updates

- Update test images when EXIF format changes
- Add tests for new EXIF fields
- Update tests when privacy controls change

### Test Data Management

- Store test images in test assets folder
- Version control test images
- Document expected EXIF values for each test image
