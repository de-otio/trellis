# EXIF Data Performance Considerations

**Purpose:** Define performance targets and optimization strategies for EXIF data extraction and storage.

---

## Performance Targets

### Extraction Time

- **Target**: < 100ms per image for EXIF extraction (p95)
- **Worst Case**: < 500ms for very large images (p99)
- **Optimization**: Extract during upload (not on-demand)

### API Response Time

- **Target**: < 50ms additional overhead when including EXIF (p95)
- **Mitigation**: Make EXIF optional via query parameter
- **Optimization**: Cache parsed EXIF data

### Database Query Time

- **Target**: < 10ms additional overhead for EXIF queries (p95)
- **Optimization**: Use denormalized fields for filtering
- **Indexing**: Index common query fields

---

## Extraction Performance

### Optimization Strategies

1. **Extract During Upload**:
   - Extract EXIF asynchronously during upload
   - Don't block upload completion
   - Store results in database

2. **Cache Results**:
   - Store extracted EXIF in database
   - Never re-extract from file
   - Parse JSON only when needed

3. **Selective Extraction**:
   - Only extract from supported formats (JPEG, TIFF)
   - Skip extraction for videos, PNG, etc.
   - Early return for unsupported formats

4. **Parallel Processing** (future):
   - Extract EXIF in parallel with image optimization
   - Use the runtime's async/concurrency primitives

### Performance Monitoring

- Log extraction time for each image
- Track p50, p95, p99 extraction times
- Alert if extraction time exceeds threshold
- Monitor extraction success rate

---

## Storage Performance

### JSON Field

- **Size**: Typically 1-5KB per media file
- **Query Performance**: Slower for filtering/searching
- **Use Case**: Flexible storage, full EXIF data

### Denormalized Fields

- **Size**: Minimal (few columns)
- **Query Performance**: Fast (indexed)
- **Use Case**: Common queries (make, model, date)

### Trade-offs

- **Storage vs. Performance**: JSON is flexible but slower
- **Schema Evolution**: JSON allows adding fields without migrations
- **Query Optimization**: Denormalized fields enable indexed queries

### Indexing Strategy

```sql
-- Index for filtering by camera make/model
CREATE INDEX idx_media_files_exif_make_model
ON media_files(exif_make, exif_model)
WHERE exif_make IS NOT NULL;

-- Index for date taken queries
CREATE INDEX idx_media_files_exif_datetime_original
ON media_files(exif_datetime_original)
WHERE exif_datetime_original IS NOT NULL;
```

---

## API Response Performance

### Response Size

- **EXIF data**: Adds 1-5KB to response
- **Mitigation**: Make EXIF optional via `includeExif` parameter
- **Compression**: Use gzip compression for API responses

### Optimization Strategies

1. **Optional Inclusion**:
   - Default: Include EXIF if available
   - Option: Exclude via `includeExif=false`
   - Reduces response size when EXIF not needed

2. **Selective Fields**:
   - Only return requested EXIF fields (future)
   - Reduce response size for specific use cases

3. **Caching**:
   - Cache formatted EXIF responses
   - Invalidate on privacy setting changes
   - Use a CDN / HTTP cache layer

---

## Database Performance

### Query Optimization

1. **Use Denormalized Fields**:
   - Filter by `exifMake`, `exifModel` (indexed)
   - Avoid querying JSON field when possible

2. **Index Strategy**:
   - Index common query fields
   - Partial indexes (WHERE exif_make IS NOT NULL)
   - Composite indexes for common queries

3. **JSON Query Performance**:
   - PostgreSQL JSON queries are slower
   - Use JSONB for better performance (if needed)
   - Avoid JSON queries in hot paths

### Migration Performance

- **Add JSON field**: Fast (nullable, no data migration)
- **Add denormalized fields**: Fast (nullable, backfill optional)
- **Add indexes**: Fast (can be done concurrently)

---

## Frontend Performance

### Rendering Performance

- **Lazy Loading**: Load EXIF sections on demand (future)
- **Virtual Scrolling**: For media lists with EXIF (if needed)
- **Memoization**: Cache formatted EXIF values

### Network Performance

- **Request Optimization**: Only request EXIF when needed
- **Response Caching**: Cache EXIF data in client-side state
- **Progressive Loading**: Show basic info first, EXIF later

---

## Monitoring and Alerts

### Key Metrics

1. **Extraction Time**:
   - p50, p95, p99 extraction times
   - Alert if p95 > 200ms

2. **Extraction Success Rate**:
   - % of images with EXIF extracted
   - Alert if success rate < 90%

3. **API Response Time**:
   - Additional overhead from EXIF
   - Alert if overhead > 100ms

4. **Database Query Time**:
   - Query time with EXIF fields
   - Alert if query time > 50ms

### Performance Dashboards

- Grafana dashboard for EXIF metrics
- Track extraction times over time
- Monitor API response times
- Database query performance

---

## Optimization Roadmap

### Phase 1 (Initial Implementation)

- Extract during upload
- Store in database
- Basic caching

### Phase 2 (Optimization)

- Denormalized fields for queries
- Response caching
- Selective field extraction

### Phase 3 (Advanced)

- Parallel extraction
- Lazy loading in frontend
- Advanced indexing strategies

---

## Benchmarking

### Baseline Measurements

- Current upload time (without EXIF)
- Current API response time (without EXIF)
- Current database query time

### Target Measurements

- Upload time with EXIF: < 100ms additional
- API response time with EXIF: < 50ms additional
- Database query time with EXIF: < 10ms additional

### Testing Methodology

- Test with various image sizes (1MB - 10MB)
- Test with various EXIF data sizes
- Test with/without EXIF data
- Measure p50, p95, p99 percentiles
