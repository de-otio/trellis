# Media Metadata Security Considerations

**Purpose:** Define security measures and best practices for handling EXIF, IPTC, and video metadata.

**⚠️ IMPORTANT:** See [Security & Best Practices Review](./security-best-practices-review.md) for comprehensive security analysis and required fixes.

---

## Input Validation

**⚠️ CRITICAL:** All metadata must be validated before storage. See [Security Review](./security-best-practices-review.md) for detailed validation requirements.

### Metadata Structure Validation

- **Use Zod schemas** for all metadata types (EXIF, IPTC, video)
- Validate metadata structure before storing
- Reject malformed metadata
- Handle corrupted metadata gracefully
- **Size limits**: Maximum 50KB per metadata type (JSON string)

### String Fields

- **Sanitize all string fields** using `InputSanitizer.sanitizeText()`
- Limit string length (prevent DoS):
  - Make/Model: 100 characters
  - Software: 200 characters
  - Copyright: 500 characters
  - Other fields: 200 characters
- Validate character encoding (UTF-8)
- Strip HTML/script tags

### GPS Coordinates

- **Validate GPS coordinates** (CRITICAL):
  - Latitude: -90 to 90 (inclusive)
  - Longitude: -180 to 180 (inclusive)
  - Altitude: -500m to 9000m (reasonable range)
- Reject invalid coordinates (NaN, Infinity, out of range)
- Handle coordinate format variations
- **Apply to both EXIF and video metadata**

### Date/Time Fields

- Validate date formats (ISO 8601)
- Reject dates far in future/past:
  - Minimum: January 1, 1900
  - Maximum: 1 year in future from current date
- Handle timezone information
- Convert to UTC for storage

### IPTC Keywords

- **Validate keywords array**:
  - Maximum 100 keywords per image
  - Maximum 100 characters per keyword
  - Sanitize each keyword
  - Remove duplicates
  - Reject non-string values

---

## Privacy

### Location Data Protection

- **Never expose location data without explicit user consent**
- Default: Hide location data (`locationVisible=false`)
- Applies to **both EXIF and video metadata** GPS data
- Require explicit user action to enable location visibility
- Clear UI indication when location is visible
- Log location data access for audit

### Access Control

- Only media owner can view metadata (EXIF, IPTC, video)
- Only media owner can update privacy settings
- Metadata not exposed in public APIs
- Validate ownership on all metadata-related endpoints
- Use session-based authentication for all metadata endpoints

### Data Minimization

- Only extract necessary metadata fields
- Don't extract sensitive fields unless needed
- Allow users to strip metadata on upload (future enhancement)
- Respect user privacy preferences
- **IPTC keywords**: Only extract if needed for content discovery

---

## Data Integrity

### Validation

- Validate EXIF data format
- Verify data consistency
- Handle corrupted EXIF gracefully
- Don't trust EXIF data for security decisions

### Tampering Detection

- EXIF data can be modified
- Don't rely on EXIF for authentication
- Don't use EXIF for security checks
- Validate against other sources if needed

### Storage

- Store EXIF data securely in database
- Encrypt sensitive fields if needed (future)
- Backup EXIF data with media files
- Handle data loss scenarios

---

## Audit Logging

### Access Logging

- Log EXIF data access (optional)
- Log location data access (recommended)
- Track privacy setting changes
- Monitor for suspicious patterns

### Log Format

```typescript
{
  timestamp: string,
  userId: string,
  mediaId: string,
  action: 'view_exif' | 'update_privacy' | 'access_location',
  details: {
    exifFields: string[],
    locationVisible: boolean,
  }
}
```

### Retention

- Retain logs for compliance period
- Anonymize logs after retention period
- Secure log storage

---

## Compliance

### GDPR

- EXIF data is personal data (especially location)
- User has right to access their EXIF data
- User has right to delete EXIF data
- User has right to restrict processing
- Provide clear privacy controls

### Data Export

- Include EXIF in user data exports
- Format: JSON or CSV
- Include all EXIF fields
- Respect privacy settings in export

### Data Deletion

- Delete EXIF when media is deleted
- Allow users to delete EXIF separately
- Verify deletion completeness
- Log deletion events

---

## Best Practices

### For Developers

1. **Validate all input**: Never trust EXIF data
2. **Respect privacy**: Hide sensitive data by default
3. **Secure storage**: Encrypt if needed
4. **Audit access**: Log sensitive data access
5. **Handle errors**: Graceful degradation

### For Users

1. **Review settings**: Check privacy settings
2. **Strip if needed**: Use EXIF stripping for sensitive photos
3. **Understand risks**: Location data can reveal patterns
4. **Control sharing**: Be aware of EXIF in shared media

---

## Threat Model

### Potential Threats

1. **Location Tracking**: GPS data reveals user locations
2. **Device Fingerprinting**: Camera model can identify users
3. **Timeline Reconstruction**: Date/time reveals activity patterns
4. **Metadata Leakage**: EXIF exposed in shared media

### Mitigations

1. **Hide by default**: Location hidden by default
2. **User control**: Clear privacy settings
3. **Stripping option**: Allow EXIF removal
4. **Access control**: Only owner can view EXIF

---

## Security Checklist

### Pre-Implementation (CRITICAL)

- [ ] **Create Zod schemas** for all metadata types (EXIF, IPTC, video)
- [ ] **Implement input sanitization** for all string fields
- [ ] **Add GPS coordinate validation** (EXIF and video)
- [ ] **Add size limits** on metadata JSON (50KB per type)
- [ ] **Add API validation schemas** using Zod
- [ ] **Review dependency vulnerabilities** (`exifr` package)
- [ ] **Add keyword validation** (max 100, length limits)

### Implementation

- [ ] Validate all metadata input (EXIF, IPTC, video)
- [ ] Sanitize all string fields
- [ ] Validate GPS coordinates (both sources)
- [ ] Hide location by default
- [ ] Implement access control
- [ ] Add rate limiting to upload endpoint
- [ ] Wrap database operations in transactions
- [ ] Add audit logging (location access, privacy changes)
- [ ] Handle errors gracefully
- [ ] Test security measures with malicious inputs

### Deployment

- [ ] Review security measures (see Security Review document)
- [ ] Test privacy controls
- [ ] Verify access control
- [ ] Security audit
- [ ] Penetration testing
- [ ] Monitor for issues
- [ ] Update as needed

---

## Incident Response

### Data Breach

- If EXIF data exposed: Notify affected users
- If location data exposed: Immediate notification
- Document incident
- Remediate vulnerability

### Privacy Violation

- If privacy setting ignored: Fix immediately
- If location exposed: Notify user
- Review access logs
- Update controls if needed

---

## Future Enhancements

### Encryption

- Encrypt sensitive EXIF fields at rest
- Encrypt location data separately
- Key management for encryption

### Advanced Privacy

- Location obfuscation (round coordinates)
- Time-based visibility (auto-hide after time)
- Selective sharing (different settings per audience)

### Compliance Tools

- Privacy dashboard
- Consent management
- Data export/deletion tools
