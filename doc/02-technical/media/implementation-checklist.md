# EXIF Data Implementation Checklist

> Implementation paths are in the trellis core (`apps/api/src/lib/media/`). The reference deployment uses JWT bearer auth and object storage (S3 or compatible).

This checklist is derived from the **EXIF Data Implementation Plan** and tracks the progress of each task across all phases.

> **⚠️ IMPORTANT:** Phase 0 (Security Setup) must be completed before starting Phase 1. See [Security & Best Practices Review](./security-best-practices-review.md) for details.

---

## Phase 0: Pre-Implementation Security Setup (CRITICAL)

> **Note:** These items are required before starting Phase 1. See [Security & Best Practices Review](./security-best-practices-review.md) for detailed requirements.

### Security Infrastructure

- [ ] Define module locations + exports for metadata utilities
  - [ ] Decide directory structure (e.g. `src/lib/metadata/*`)
  - [ ] Ensure ESM-friendly exports
  - [ ] Add barrel export (e.g. `src/lib/metadata/index.ts`) if used

- [ ] Create `metadata-config.ts` configuration file
  - [ ] Define `MAX_METADATA_SIZE` (50KB default)
  - [ ] Define `MAX_KEYWORDS` (100 default)
  - [ ] Define `MAX_KEYWORD_LENGTH` (100 default)
  - [ ] Define `EXTRACTION_TIMEOUT` (5s default)
  - [ ] Define `MAX_STRING_FIELD_LENGTH` limits
  - [ ] Define behavior: truncate vs reject for oversized strings/arrays (document decision)

- [ ] Create `metadata-schemas.ts` validation schemas
  - [ ] Create `EXIFDataSchema` with Zod
  - [ ] Create `IPTCDataSchema` with Zod
  - [ ] Create `VideoMetadataSchema` with Zod
  - [ ] Create `MetadataVisibilitySchema` for API validation
  - [ ] Add GPS coordinate validation (lat: -90 to 90, lon: -180 to 180; reject NaN/Infinity)
  - [ ] Add date validation (1900-01-01 to 1 year in future)

- [ ] Create `metadata-sanitizer.ts` utility class
  - [ ] Implement `sanitizeString()` method (strip control chars, normalize whitespace, prevent XSS payload persistence)
  - [ ] Implement `validateGPS()` method
  - [ ] Implement `validateKeywords()` method
  - [ ] Implement `validateDate()` method
  - [ ] Implement `validateMetadataSize()` method
  - [ ] Define and implement “sanitize then validate” ordering rules
- [ ] Create `metadata-errors.ts` custom error classes
  - [ ] Create `MetadataExtractionError` class (include type: exif/iptc/video; include root cause)
  - [ ] Create `MetadataValidationError` class (include schema issues, field paths)

- [ ] Decide structured logging format for metadata pipeline
  - [ ] Define required fields (userId, mediaId, fileType, extractionType, errorCode, durationMs, timestamp)
  - [ ] Define PII rules (do not log raw GPS; do not log full metadata payloads)

### Dependency Review

- [ ] Review `exifr` package for vulnerabilities
  - [ ] Run `npm audit`
  - [ ] Pin exact version (7.1.3) in package.json
  - [ ] Verify runtime compatibility (supports ArrayBuffer/Uint8Array)
  - [ ] Check license compatibility
- [ ] Decide approach/library for **video metadata extraction**
  - [ ] Confirm runtime compatibility (avoid native binaries if targeting edge runtimes)
  - [ ] Document supported containers/fields (what is feasible vs “best effort”)
- [ ] Set up Dependabot for security updates

---

## Phase 1: Backend – Metadata Extraction (Week 1)

### Package Installation

- [ ] Install `exifr` package
  - [ ] Add to `package.json` (pinned version: 7.1.3)
  - [ ] Verify compatibility with the target bundler/runtime

### MetadataExtractor Implementation

- [ ] Create `MetadataExtractor` utility class
  - [ ] Ensure Workers-friendly input types (ArrayBuffer/Uint8Array) and no Node globals
  - [ ] Implement timeout enforcement using `EXTRACTION_TIMEOUT`
    - [ ] Implement guard (e.g. `Promise.race`) and standardized timeout error code
    - [ ] Decide behavior on timeout (store partial/none; always log)
  - [ ] Implement EXIF extraction logic
    - [ ] Use Zod schema validation
    - [ ] Sanitize all string fields
    - [ ] Validate GPS coordinates
    - [ ] Validate and format dates
  - [ ] Implement IPTC extraction logic
    - [ ] Use Zod schema validation
    - [ ] Validate and sanitize keywords
    - [ ] Sanitize all string fields
  - [ ] Implement video metadata extraction logic (per chosen approach)
    - [ ] Use Zod schema validation
    - [ ] Validate GPS coordinates
    - [ ] Validate and format dates
  - [ ] Add error handling for each type (independent failures)
  - [ ] Add structured logging (extraction failures, validation errors, durations)
  - [ ] Implement `extractAll()` with `Promise.allSettled` for parallel extraction
  - [ ] Add explicit metadata size checks pre- and post-extraction
    - [ ] Reject or truncate according to Phase 0 decision
    - [ ] Ensure stored JSON fits within DB limits

### Upload Handler Integration

- [ ] Integrate metadata extraction into upload handler
  - [ ] Modify upload route handler
  - [ ] **Extract from ORIGINAL file BEFORE any processing** (critical for metadata preservation)
  - [ ] Extract EXIF and IPTC for images (in parallel)
  - [ ] Extract video metadata for videos
  - [ ] Handle extraction failures gracefully (each type independently)
  - [ ] Add rate limiting to upload endpoint (10 uploads per 60 seconds)
    - [ ] Choose rate limit storage/strategy compatible with Workers (not in-memory)
    - [ ] Define keying strategy (userId vs IP vs both)
    - [ ] Standardize 429 response shape
  - [ ] Wrap database operations in transactions
  - [ ] Add security logging for extraction failures (no raw metadata payloads)
  - [ ] Feature flag gating (if used)
    - [ ] Ensure extraction/storage behavior matches flag state
    - [ ] Ensure safe defaults when flag is OFF

### Database Schema

- [ ] Update database schema
  - [ ] Add `exifData`, `iptcData`, `videoMetadata` JSON fields
  - [ ] Add denormalized fields (date, GPS, keywords)
  - [ ] Add unified privacy flags (`metadataVisible`, `locationVisible`)
  - [ ] Add indexes for common queries (make, model, date, keywords)
  - [ ] Add GIN index for keywords array (if Postgres)
- [ ] Decide data retention/storage policy (document)
  - [ ] Store raw metadata regardless of visibility flags (recommended) vs redact on ingest
  - [ ] Confirm GPS policy: stored but hidden by default; filtered at read-time
  - [ ] Confirm deletion behavior: metadata removed on media/account deletion

### Migration

- [ ] Create migration
  - [ ] Write Prisma migration
  - [ ] Test migration on dev database
  - [ ] Document rollback procedure
  - [ ] Define deploy order for safe rollout (backward-compatible API/code before/after migration)
  - [ ] Decide on backfill strategy for existing media (optional)
    - [ ] If backfill: add job/worker plan + rate limits + monitoring

### API Response

- [ ] Update `getMediaDetails` to return all metadata types
  - [ ] Define and implement exact API response schema (field names + JSON shapes)
  - [ ] Parse EXIF, IPTC, video metadata from database
  - [ ] Format for API response (stable types; avoid leaking raw library output)
  - [ ] Apply privacy filters
  - [ ] Determine unified `dateTaken` field
  - [ ] Implement query parameter behavior (if supported)
    - [ ] `includeMetadata`, `includeExif` (document exact semantics)
  - [ ] Add caching headers (private, max-age=300)
  - [ ] Feature flag gating (if used): ensure response is stable when flag OFF

---

## Phase 2: Backend – Privacy Controls (Week 1‑2)

### Database Schema

- [ ] Add unified privacy flags to database schema
  - [ ] `metadataVisible` (default: true)
  - [ ] `locationVisible` (default: false)

### Privacy Endpoints

- [ ] Implement metadata visibility update endpoint
  - [ ] `PATCH /api/media/:mediaId/metadata-visibility`
  - [ ] Legacy endpoint: `PATCH /api/media/:mediaId/exif-visibility` (maps to new one)
  - [ ] Validate user ownership
  - [ ] Update privacy settings
  - [ ] Use Zod schema for request validation
  - [ ] Add rate limiting (30 requests per 60 seconds)
    - [ ] Choose Workers-compatible storage
    - [ ] Standardize 429 response
  - [ ] Wrap in database transaction
  - [ ] Emit audit log entry (structured)

- [ ] Define backwards compatibility/deprecation behavior
  - [ ] Keep legacy fields/endpoints working for defined period
  - [ ] Document removal timeline and add tracking issue

### Privacy Filtering

- [ ] Filter location data based on privacy settings
  - [ ] Check `locationVisible` flag
  - [ ] Remove GPS data from EXIF response if hidden
  - [ ] Remove GPS data from video metadata response if hidden
  - [ ] Apply filter in `getMediaDetails`
  - [ ] Ensure filtering happens consistently even when `includeMetadata=true`

### User Preferences

- [ ] Add user preference defaults
  - [ ] Set defaults during upload
  - [ ] Respect user preferences if available
  - [ ] Decide precedence rules (user defaults vs per-media overrides)

### Security Logging

- [ ] Add audit logging
  - [ ] Log privacy setting changes
  - [ ] Log location data access (when returned due to `locationVisible=true`)
  - [ ] Include userId, mediaId, timestamp in logs
  - [ ] Do not log precise coordinates

---

## Phase 3: Frontend – Display (Week 2)

### Data Model

- [ ] Update `MediaDetails` entity/model
  - [ ] Add EXIF data fields
  - [ ] Add IPTC data fields (keywords, copyright)
  - [ ] Add video metadata fields
  - [ ] Add unified `dateTaken` field
  - [ ] Add unified privacy flag fields (`metadataVisible`, `locationVisible`)
  - [ ] Update JSON deserialization
  - [ ] Ensure model tolerates absent/partial metadata (best-effort extraction)

### UI Components

- [ ] Add metadata display sections to `MediaDetailPage`
  - [ ] Camera Information section (EXIF)
  - [ ] Camera Settings section (EXIF)
  - [ ] Date & Location section (unified from EXIF or video)
  - [ ] IPTC Keywords section (display as chips)
  - [ ] IPTC Copyright section
  - [ ] Video Information section (for videos)
  - [ ] Image Properties section (EXIF)

### Value Formatting

- [ ] Format metadata values
  - [ ] Shutter speed formatting
  - [ ] Aperture formatting (f/2.8)
  - [ ] Date/time formatting (unified `dateTaken`)
  - [ ] Location formatting (from EXIF or video)
  - [ ] Bitrate formatting (video)

### Privacy Controls

- [ ] Add privacy toggle switches
  - [ ] Metadata visibility toggle (unified for all types)
  - [ ] Location visibility toggle (unified for EXIF and video)
  - [ ] Update handlers
  - [ ] Handle optimistic UI + rollback on API failure

### Empty States

- [ ] Add empty states
  - [ ] No metadata message
  - [ ] Metadata hidden message

---

## Phase 4: Testing & Polish (Week 2‑3)

### Unit Tests

- [ ] Write unit tests for metadata extraction
  - [ ] Test EXIF extraction (various image formats)
  - [ ] Test IPTC extraction (keywords, copyright)
  - [ ] Test video metadata extraction (supported containers)
  - [ ] Test edge cases for each type
  - [ ] Test error handling (independent failures)
  - [ ] Test timeout behavior

### Security Tests

- [ ] Write security tests
  - [ ] Test with malicious metadata (XSS payloads)
  - [ ] Test with extremely large metadata (>50KB)
  - [ ] Test with invalid GPS coordinates (NaN, Infinity, out of range)
  - [ ] Test with malformed dates
  - [ ] Test with oversized keyword arrays (>100 keywords)
  - [ ] Test rate limiting on upload endpoint
  - [ ] Test rate limiting on metadata-visibility endpoint
  - [ ] Test access control (unauthorized access, ownership validation)
  - [ ] Test that logs do not contain raw metadata or precise GPS

### Integration Tests

- [ ] Write integration tests for upload flow
  - [ ] Test EXIF and IPTC extraction during upload (parallel)
  - [ ] Test video metadata extraction during upload
  - [ ] Test storage in database (all types)
  - [ ] Test API responses (all types)
  - [ ] Test transaction rollback on failure

### E2E Tests

- [ ] Write E2E tests for user flows
  - [ ] Test upload image with metadata → view details flow
  - [ ] Test upload video with metadata → view details flow
  - [ ] Test privacy toggle flows (unified)
  - [ ] Test IPTC keywords display
  - [ ] Test empty states

### Device/Format Testing

- [ ] Test with various sources
  - [ ] Canon, Nikon, Sony cameras (EXIF)
  - [ ] iPhone, Android phones (EXIF, video metadata)
  - [ ] Professional cameras with IPTC keywords
  - [ ] Various image and video formats

### Performance Testing

- [ ] Performance testing
  - [ ] Measure extraction time (EXIF, IPTC, video)
  - [ ] Measure parallel extraction performance
  - [ ] Measure API response time
  - [ ] Verify extraction < 100ms per file (p95)
  - [ ] Verify parallel extraction < 150ms (p95)
  - [ ] Verify API overhead < 50ms (p95)
  - [ ] Optimize if needed

---

## Phase 5: Deployment & Rollout (Week 3)

### Pre-Deployment Checklist

- [ ] All tests passing
- [ ] Code review completed
- [ ] Performance benchmarks met
- [ ] Security review completed
- [ ] Documentation updated

### Staging Deployment

- [ ] Deploy backend changes to staging
  - [ ] Deploy API with metadata extraction
  - [ ] Deploy database migration
  - [ ] Verify migration success
- [ ] Test with various image formats
  - [ ] JPEG with EXIF
  - [ ] JPEG without EXIF
  - [ ] PNG (no EXIF)
  - [ ] Various camera models
- [ ] Verify privacy controls
  - [ ] Location hidden by default
  - [ ] Toggle functionality works
  - [ ] Privacy settings respected
- [ ] Performance testing on staging
  - [ ] Measure extraction times
  - [ ] Measure API response times
  - [ ] Verify no degradation
- [ ] User acceptance testing
  - [ ] Internal team testing
  - [ ] Gather feedback
  - [ ] Fix critical issues

### Production Deployment

- [ ] Configure feature flag for gradual rollout
  - [ ] Confirm flag gates upload extraction + API response + frontend display
- [ ] Soft launch (10% of users)
  - [ ] Deploy to 10% of users
  - [ ] Monitor closely for issues
- [ ] Monitor metrics
  - [ ] Extraction success rate (target: >90%)
  - [ ] Performance metrics (extraction time, API response time)
  - [ ] Error rates (API errors <1%, extraction errors <5%)
  - [ ] User feedback
- [ ] Fix critical issues if any
- [ ] Gradual rollout (50%)
  - [ ] Increase to 50% if metrics look good
  - [ ] Continue monitoring
- [ ] Full rollout (100%)
  - [ ] If no issues at 50%
  - [ ] Monitor for 1 week

### Rollback Plan

- [ ] Document feature flag configuration
- [ ] Document database migration rollback procedure
- [ ] Define rollback triggers
  - [ ] Extraction success rate < 80%
  - [ ] Performance degradation > 50%
  - [ ] Critical security issues
  - [ ] User complaints > threshold

### Post-Launch Monitoring

- [ ] Week 1: Daily monitoring
- [ ] Week 2-4: Weekly reviews
- [ ] Month 2+: Monthly reviews

---

## Phase 6: Documentation

- [ ] Update API documentation
  - [ ] Document new metadata fields in response (exact shapes + examples)
  - [ ] Document metadata-visibility endpoint
  - [ ] Document query parameters (includeMetadata, includeExif) and semantics
  - [ ] Document legacy endpoint behavior and deprecation timeline
- [ ] Update security documentation
  - [ ] Document privacy controls
  - [ ] Document rate limiting (keys, limits, 429 response)
  - [ ] Document audit logging (what is logged, what is never logged)
- [ ] Create operations runbook
  - [ ] Monitoring procedures
  - [ ] Incident response procedures
  - [ ] Rollback procedures
- [ ] Update user documentation
  - [ ] Privacy settings guide
  - [ ] Metadata visibility guide

---

> **Note:** This checklist is intended for developers to track progress. Mark each item as completed when the corresponding task is finished.

> **References:**
>
> - [Implementation Plan](./implementation-plan.md)
> - [Security & Best Practices Review](./security-best-practices-review.md)
> - [Implementation Details](./implementation-details.md)
> - [Testing Requirements](./testing-requirements.md)
> - [Rollout Strategy](./rollout-strategy.md)
