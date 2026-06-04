# EXIF Data Implementation Plan

> Implementation targets the trellis core (`apps/api/src/lib/media/`). Phase timelines are notional.

**Purpose:** Define phased rollout strategy and tasks for implementing EXIF data support.

---

## Implementation Phases

### Phase 1: Backend - Metadata Extraction (Week 1)

**Duration:** 1 week

**Tasks:**

1. Install `exifr` package
   - Add to `package.json`
   - Verify it runs in the target runtime (Node.js)

2. Create `MetadataExtractor` utility class
   - Implement EXIF extraction logic
   - Implement IPTC extraction logic
   - Implement video metadata extraction logic
   - Add error handling for each type
   - Add logging

3. Integrate metadata extraction into upload handler
   - Modify upload route handler
   - Extract EXIF and IPTC for images (in parallel)
   - Extract video metadata for videos
   - Handle extraction failures gracefully (each type independently)

4. Update database schema
   - Add `exifData`, `iptcData`, `videoMetadata` JSON fields
   - Add denormalized fields (date, GPS, keywords)
   - Add unified privacy flags (`metadataVisible`, `locationVisible`)

5. Create migration
   - Write Prisma migration
   - Test migration on dev database
   - Document rollback procedure

6. Update `getMediaDetails` to return all metadata types
   - Parse EXIF, IPTC, video metadata from database
   - Format for API response
   - Apply privacy filters
   - Determine unified `dateTaken` field

**Deliverables:**

- Metadata extraction utility (`apps/api/src/lib/metadata-extractor.ts`)
- Database migration (`prisma/migrations/add_media_metadata/migration.sql`)
- Updated API response (includes EXIF, IPTC, video metadata)

**Acceptance Criteria:**

- ✅ EXIF data extracted from uploaded images
- ✅ IPTC keywords extracted from uploaded images
- ✅ Video metadata extracted from uploaded videos
- ✅ All metadata stored in database
- ✅ All metadata returned in API response
- ✅ Unified `dateTaken` field populated correctly
- ✅ Extraction failures don't break upload (each type independent)
- ✅ All tests passing

---

### Phase 2: Backend - Privacy Controls (Week 1-2)

**Duration:** 3-5 days

**Tasks:**

1. Add unified privacy flags to database schema
   - `metadataVisible` (default: true) - applies to all metadata types
   - `locationVisible` (default: false) - applies to GPS in EXIF and video

2. Implement metadata visibility update endpoint
   - `PATCH /api/media/:mediaId/metadata-visibility`
   - Legacy endpoint: `PATCH /api/media/:mediaId/exif-visibility` (maps to new one)
   - Validate user ownership
   - Update privacy settings

3. Filter location data based on privacy settings
   - Check `locationVisible` flag
   - Remove GPS data from EXIF response if hidden
   - Remove GPS data from video metadata response if hidden
   - Apply filter in `getMediaDetails`

4. Add user preference defaults
   - Set defaults during upload
   - Respect user preferences if available

**Deliverables:**

- Privacy control endpoint (with legacy support)
- Privacy filtering logic (for all metadata types)
- Updated API responses

**Acceptance Criteria:**

- ✅ Location data hidden by default (for both EXIF and video)
- ✅ Users can toggle metadata visibility (all types)
- ✅ Users can toggle location visibility (unified for all types)
- ✅ Privacy settings respected in API responses
- ✅ Legacy endpoint works for backward compatibility
- ✅ All tests passing

---

### Phase 3: Frontend - Display (Week 2)

**Duration:** 1 week

**Tasks:**

1. Update `MediaDetails` entity/model
   - Add EXIF data fields
   - Add IPTC data fields (keywords, copyright)
   - Add video metadata fields
   - Add unified `dateTaken` field
   - Add unified privacy flag fields (`metadataVisible`, `locationVisible`)
   - Update JSON deserialization

2. Add metadata display sections to `MediaDetailPage`
   - Camera Information section (EXIF)
   - Camera Settings section (EXIF)
   - Date & Location section (unified from EXIF or video)
   - IPTC Keywords section (display as chips)
   - IPTC Copyright section
   - Video Information section (for videos)
   - Image Properties section (EXIF)

3. Format metadata values
   - Shutter speed formatting
   - Aperture formatting (f/2.8)
   - Date/time formatting (unified dateTaken)
   - Location formatting (from EXIF or video)
   - Bitrate formatting (video)

4. Add privacy toggle switches
   - Metadata visibility toggle (unified for all types)
   - Location visibility toggle (unified for EXIF and video)
   - Update handlers

5. Add empty states
   - No metadata message
   - Metadata hidden message

**Deliverables:**

- Updated media detail page
- Metadata display components (EXIF, IPTC, video)
- Privacy control UI
- IPTC keywords display (chips)

**Acceptance Criteria:**

- ✅ All metadata types displayed in organized sections
- ✅ IPTC keywords displayed as chips
- ✅ Unified dateTaken field displayed
- ✅ Values formatted correctly
- ✅ Privacy toggles functional (unified)
- ✅ Empty states handled
- ✅ All tests passing

---

### Phase 4: Testing & Polish (Week 2-3)

**Duration:** 3-5 days

**Tasks:**

1. Write unit tests for metadata extraction
   - Test EXIF extraction (various image formats)
   - Test IPTC extraction (keywords, copyright)
   - Test video metadata extraction
   - Test edge cases for each type
   - Test error handling (independent failures)

2. Write integration tests for upload flow
   - Test EXIF and IPTC extraction during upload (parallel)
   - Test video metadata extraction during upload
   - Test storage in database (all types)
   - Test API responses (all types)

3. Write E2E tests for user flows
   - Test upload image with metadata → view details flow
   - Test upload video with metadata → view details flow
   - Test privacy toggle flows (unified)
   - Test IPTC keywords display
   - Test empty states

4. Test with various sources
   - Canon, Nikon, Sony cameras (EXIF)
   - iPhone, Android phones (EXIF, video metadata)
   - Professional cameras with IPTC keywords
   - Various image and video formats

5. Performance testing
   - Measure extraction time (EXIF, IPTC, video)
   - Measure parallel extraction performance
   - Measure API response time
   - Optimize if needed

**Deliverables:**

- Comprehensive test suite
- Performance benchmarks
- Test documentation

**Acceptance Criteria:**

- ✅ All tests passing
- ✅ Metadata extraction < 100ms per file (p95)
- ✅ Parallel extraction (EXIF + IPTC) < 150ms (p95)
- ✅ No performance degradation
- ✅ Test coverage > 90% for metadata code

---

## Timeline Summary

| Phase     | Duration      | Key Deliverables                                         | Status          |
| --------- | ------------- | -------------------------------------------------------- | --------------- |
| Phase 1   | Week 1        | Metadata extraction (EXIF, IPTC, video), database schema | ⚪ Pending      |
| Phase 2   | Week 1-2      | Privacy controls, filtering (unified)                    | ⚪ Pending      |
| Phase 3   | Week 2        | Frontend display, UI components (all metadata types)     | ⚪ Pending      |
| Phase 4   | Week 2-3      | Tests, performance, polish                               | ⚪ Pending      |
| **Total** | **2-3 weeks** | **Complete metadata support**                            | **Not started** |

---

## Dependencies

### External Dependencies

- `exifr` npm package (^7.1.3)
- PostgreSQL JSON field support (already available)

### Internal Dependencies

- Media upload system (already exists)
- Media details API (already exists)
- Media detail page (already exists)

---

## Risk Mitigation

### Technical Risks

**Risk:** EXIF extraction fails for some image formats  
**Mitigation:** Graceful error handling, continue without EXIF

**Risk:** Performance impact from EXIF extraction  
**Mitigation:** Extract during upload (async), cache results

**Risk:** Privacy concerns with location data  
**Mitigation:** Hide by default, clear user controls

### Schedule Risks

**Risk:** Delays in testing phase  
**Mitigation:** Start testing early, parallel development

**Risk:** Frontend complexity  
**Mitigation:** Reuse existing UI patterns, incremental development

---

## Success Criteria

### Functional

- ✅ EXIF data extracted from uploaded images
- ✅ IPTC keywords extracted from uploaded images
- ✅ Video metadata extracted from uploaded videos
- ✅ All metadata displayed on media details page
- ✅ Unified dateTaken field working
- ✅ Privacy controls functional (unified)
- ✅ All user flows working

### Performance

- ✅ Metadata extraction < 100ms per file (p95)
- ✅ Parallel extraction (EXIF + IPTC) < 150ms (p95)
- ✅ API response time < 50ms additional overhead (p95)
- ✅ No degradation in upload performance

### Quality

- ✅ Test coverage > 90%
- ✅ All tests passing
- ✅ No critical bugs

---

## Rollout Strategy

### Staging

1. Deploy backend changes
2. Test with various image formats
3. Verify privacy controls
4. Performance testing

### Production

1. **Soft Launch**: Deploy to 10% of users
2. **Monitor**: Watch for errors, performance issues
3. **Gradual Rollout**: Increase to 50%, then 100%
4. **Post-Launch**: Monitor adoption, gather feedback

---

## Next Steps

1. Review and approve implementation plan
2. Create implementation tickets
3. Assign developers to phases
4. Schedule kickoff meeting
5. Begin Phase 1 implementation
