# EXIF Data Privacy Considerations

**Purpose:** Define privacy controls and sensitive data handling for EXIF metadata.

---

## Sensitive Information

EXIF data can contain sensitive information:

- **GPS coordinates**: Exact location where photo was taken
- **Device information**: Camera model, serial numbers
- **Date/time**: When photo was actually taken (may differ from upload time)
- **Personal information**: Artist name, copyright

---

## Privacy Controls

### Default Behavior

1. **EXIF data visible**: `true` (show camera settings by default)
2. **Location visible**: `false` (hide GPS by default for privacy)

### User Preferences

1. **Per-media toggles**:
   - EXIF visibility toggle (show/hide all EXIF data)
   - Location visibility toggle (show/hide GPS coordinates)

2. **Global user preference** (future enhancement):
   - Default EXIF visibility for all new media
   - Default location visibility for all new media

### EXIF Stripping Option

- Allow users to strip EXIF data on upload (future enhancement)
- Respect `EXIF_STRIPPING_ENABLED` environment variable
- Strip location data if user preference is set

---

## Data Retention

### Storage

- EXIF data stored in database (can be deleted with media)
- EXIF data in original files: Respect user's EXIF stripping preference
- Location data: Only stored if user explicitly enables it (or if extracted, but filtered in responses)

### Deletion

- When media is deleted: EXIF data is also deleted
- When user requests data deletion: EXIF data is included
- No separate retention policy for EXIF data

---

## Privacy by Design

### Location Data Handling

1. **Extraction**: Extract GPS data during upload (if present)
2. **Storage**: Store in database (for user's own access)
3. **Display**: Only show if `exifLocationVisible=true`
4. **API Response**: Filter out GPS data if privacy setting is false

### Implementation

```typescript
// During upload - store all EXIF data
const exifData = await extractor.extract(imageBuffer, mimeType);
// Store everything, including GPS

// In API response - filter based on privacy
if (!media.exifLocationVisible && exifData) {
  delete exifData.GPSLatitude;
  delete exifData.GPSLongitude;
  delete exifData.GPSAltitude;
  delete exifData.GPSLocation;
}
```

---

## User Consent

### Explicit Consent for Location

- Location data is hidden by default
- User must explicitly enable location visibility
- Clear UI indication when location is visible
- Warning about location privacy when enabling

### Implicit Consent for Camera Settings

- Camera settings (ISO, aperture, etc.) are visible by default
- Less sensitive than location data
- User can hide if desired

---

## Compliance Considerations

### GDPR

- EXIF data is personal data (especially location)
- User has right to access their EXIF data
- User has right to delete EXIF data
- User has right to restrict processing

### Data Minimization

- Only extract necessary EXIF fields
- Don't extract sensitive fields unless needed
- Allow users to strip EXIF on upload

### Transparency

- Clear indication when EXIF data is present
- Clear indication when location data is visible
- User-friendly privacy controls

---

## Security Measures

### Access Control

- Only media owner can view EXIF data
- Only media owner can update privacy settings
- EXIF data not exposed in public APIs

### Data Validation

- Validate GPS coordinates (latitude: -90 to 90, longitude: -180 to 180)
- Sanitize string fields (make, model, etc.)
- Validate date formats

### Audit Logging

- Log EXIF visibility changes (optional)
- Log location data access (optional)
- Track privacy setting updates

---

## Best Practices

### For Users

1. **Review location settings**: Check if location is visible before sharing
2. **Strip EXIF if needed**: Use EXIF stripping option for sensitive photos
3. **Understand implications**: Location data can reveal patterns

### For Developers

1. **Privacy by default**: Hide sensitive data by default
2. **Clear UI**: Make privacy controls obvious and easy to use
3. **Respect preferences**: Always honor user privacy settings
4. **Secure storage**: Encrypt sensitive EXIF data if needed (future)

---

## Future Enhancements

### Advanced Privacy Controls

1. **Selective stripping**: Strip only location, keep camera settings
2. **Location obfuscation**: Round coordinates to reduce precision
3. **Time-based visibility**: Auto-hide location after certain time
4. **Sharing controls**: Different privacy settings for different audiences

### Compliance Features

1. **Data export**: Include EXIF in user data exports
2. **Data deletion**: Easy way to delete all EXIF data
3. **Privacy dashboard**: Overview of EXIF data across all media
4. **Consent management**: Track and manage user consent
