# Media Metadata

> **Moved into the trellis core (round 2 dedup).** This is the generic media-metadata
> specification — EXIF / IPTC / video-metadata extraction, storage, privacy controls,
> and the API surface for displaying it. It is **framework-level capability**, not
> specific to any one product built on trellis. The consuming application supplies the
> frontend and the deployment (object storage, auth, CDN); trellis ships the extraction
> pipeline, validation, storage schema, and API. Code samples shown as Flutter widgets
> are illustrative of the display patterns, not a framework mandate.

**Status:** Specification — design reference, not yet implemented
**Companion:** [`architecture/06-async-processing.md`](../architecture/06-async-processing.md) (media-processing queue / upload pipeline)

---

## What this is

Extends the media pipeline to extract, store, and display metadata from uploaded images
and videos. Three metadata families, in priority order:

1. **EXIF** (images): camera settings, date/time taken, GPS location — **highest priority**
2. **Video metadata**: date/time taken, technical info — **high priority**
3. **IPTC** (images): keywords for content discovery, copyright — **medium priority**

### Goals

1. **Extract** metadata from the **original file before any processing** (compression,
   resize, reencode all strip metadata).
2. **Store** it for retrieval and display (full JSON + denormalized fields for queries).
3. **Display** it on a media-detail surface in a user-friendly form.
4. **Support content discovery** via IPTC keywords.
5. **Respect privacy** — users control metadata visibility and sensitive fields (GPS)
   are stripped/gated by default.

---

## Documentation structure

| # | File | Contents |
|---|------|----------|
| | [README.md](./README.md) | This file |
| 1 | [data-model.md](./data-model.md) | Storage schema (Prisma), field definitions, indexes, TypeScript interfaces |
| 2 | [api-design.md](./api-design.md) | API response extension, query params, privacy-filtering logic |
| 3 | [frontend-design.md](./frontend-design.md) | Display sections, privacy-control UI, formatting helpers (illustrative) |
| 4 | [implementation-details.md](./implementation-details.md) | `exifr`-based extractor, Zod validation, sanitizer, upload-flow integration |
| 5 | [metadata-extraction-timing.md](./metadata-extraction-timing.md) | ⚠️ When/how to extract to prevent data loss |
| 6 | [privacy-considerations.md](./privacy-considerations.md) | Privacy controls and sensitive-data handling |
| 7 | [testing-requirements.md](./testing-requirements.md) | Unit / integration / E2E test specifications |
| 8 | [implementation-plan.md](./implementation-plan.md) | Phased rollout and task breakdown |
| 9 | [implementation-checklist.md](./implementation-checklist.md) | Per-phase task checklist |
| 10 | [performance-considerations.md](./performance-considerations.md) | Performance targets and optimization strategies |
| 11 | [future-enhancements.md](./future-enhancements.md) | Phase 2+ roadmap |
| 12 | [dependencies.md](./dependencies.md) | Required packages, runtime/format compatibility |
| 13 | [security-considerations.md](./security-considerations.md) | Input validation and security measures |
| 14 | [security-best-practices-review.md](./security-best-practices-review.md) | ⚠️ Comprehensive security review (read before implementing) |
| 15 | [success-metrics.md](./success-metrics.md) | Adoption, performance, and quality metrics |
| 16 | [rollout-strategy.md](./rollout-strategy.md) | Staging/production deployment and rollback |

---

## Design highlights

- **Extract from the original.** The single most important constraint: metadata must be
  read from the original upload buffer *before* compression/resize/reencode, or it is
  lost. See [metadata-extraction-timing.md](./metadata-extraction-timing.md).
- **JSON + denormalized columns.** Full metadata is stored as JSON for flexibility;
  a handful of denormalized columns (make, model, date-taken, GPS) back indexed queries.
- **Privacy by default.** `metadataVisible` defaults on, `locationVisible` defaults off.
  Field-level granular visibility settings override the binary toggles.
- **Validation-first.** Every field passes through a Zod schema and a sanitizer (string
  length caps, GPS range checks, date sanity, keyword limits, size caps) before storage.

## Quick read path

15-minute version: README → data-model → api-design → metadata-extraction-timing.
Implementing: read all in order, starting from the security review.
