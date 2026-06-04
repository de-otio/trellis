# Media Metadata Frontend Design

> The frontend lives in the consuming application; trellis ships the API, not the UI. The code samples below are illustrative (shown as Flutter widgets) — the UI/UX patterns and metadata display concepts are the design references, not the exact framework.

**Purpose:** Define UI components and user interface changes for displaying EXIF, IPTC, and video metadata.

---

## Media Detail Page Updates

### New Metadata Display Sections

Add new sections to display metadata in organized groups:

#### Camera Information Section

```dart
_DetailSection(
  title: 'Camera Information',
  children: [
    if (details.exifData?.make != null)
      _DetailRow(
        label: 'Camera',
        value: '${details.exifData!.make} ${details.exifData!.model ?? ""}',
      ),
    if (details.exifData?.lensModel != null)
      _DetailRow(
        label: 'Lens',
        value: details.exifData!.lensModel!,
      ),
    if (details.exifData?.software != null)
      _DetailRow(
        label: 'Software',
        value: details.exifData!.software!,
      ),
  ],
),
```

#### Camera Settings Section

```dart
_DetailSection(
  title: 'Camera Settings',
  children: [
    if (details.exifData?.iso != null)
      _DetailRow(
        label: 'ISO',
        value: details.exifData!.iso!.toString(),
      ),
    if (details.exifData?.aperture != null)
      _DetailRow(
        label: 'Aperture',
        value: 'f/${details.exifData!.aperture}',
      ),
    if (details.exifData?.shutterSpeed != null)
      _DetailRow(
        label: 'Shutter Speed',
        value: details.exifData!.shutterSpeed!,
      ),
    if (details.exifData?.focalLength != null)
      _DetailRow(
        label: 'Focal Length',
        value: '${details.exifData!.focalLength}mm',
      ),
    if (details.exifData?.flash != null)
      _DetailRow(
        label: 'Flash',
        value: details.exifData!.flash! ? 'Yes' : 'No',
      ),
    if (details.exifData?.whiteBalance != null)
      _DetailRow(
        label: 'White Balance',
        value: details.exifData!.whiteBalance!,
      ),
  ],
),
```

#### Date & Location Section

```dart
_DetailSection(
  title: 'Date & Location',
  children: [
    // Use unified dateTaken field (from EXIF or video metadata)
    if (details.dateTaken != null)
      _DetailRow(
        label: 'Date Taken',
        value: _formatDateTime(details.dateTaken!),
      ),
    // Location from EXIF (images)
    if (details.exifData?.gps != null && details.locationVisible)
      _DetailRow(
        label: 'Location',
        value: details.exifData!.gps!.location ??
               '${details.exifData!.gps!.latitude}, ${details.exifData!.gps!.longitude}',
      ),
    // Location from video metadata
    if (details.videoMetadata?.gps != null && details.locationVisible)
      _DetailRow(
        label: 'Location',
        value: details.videoMetadata!.gps!.location ??
               '${details.videoMetadata!.gps!.latitude}, ${details.videoMetadata!.gps!.longitude}',
      ),
    if ((details.exifData?.gps?.altitude != null ||
         details.videoMetadata?.gps?.altitude != null) &&
        details.locationVisible)
      _DetailRow(
        label: 'Altitude',
        value: '${details.exifData?.gps?.altitude ?? details.videoMetadata?.gps?.altitude}m',
      ),
  ],
),
```

#### IPTC Keywords Section (for Content Discovery)

```dart
if (details.iptcData?.keywords != null && details.iptcData!.keywords!.isNotEmpty)
  _DetailSection(
    title: 'Keywords',
    children: [
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: details.iptcData!.keywords!.map((keyword) {
          return Chip(
            label: Text(keyword),
            onDeleted: null, // Read-only display
          );
        }).toList(),
      ),
    ],
  ),
```

#### IPTC Copyright Section

```dart
if (details.iptcData?.copyright != null)
  _DetailSection(
    title: 'Copyright',
    children: [
      _DetailRow(
        label: 'Copyright',
        value: details.iptcData!.copyright!,
      ),
      if (details.iptcData?.copyrightOwner != null)
        _DetailRow(
          label: 'Copyright Owner',
          value: details.iptcData!.copyrightOwner!,
        ),
    ],
  ),
```

#### Video Metadata Section

```dart
if (details.videoMetadata != null)
  _DetailSection(
    title: 'Video Information',
    children: [
      if (details.videoMetadata!.make != null)
        _DetailRow(
          label: 'Device',
          value: '${details.videoMetadata!.make} ${details.videoMetadata!.model ?? ""}',
        ),
      if (details.videoMetadata!.codec != null)
        _DetailRow(
          label: 'Codec',
          value: details.videoMetadata!.codec!,
        ),
      if (details.videoMetadata!.frameRate != null)
        _DetailRow(
          label: 'Frame Rate',
          value: '${details.videoMetadata!.frameRate} fps',
        ),
      if (details.videoMetadata!.bitrate != null)
        _DetailRow(
          label: 'Bitrate',
          value: _formatBitrate(details.videoMetadata!.bitrate!),
        ),
    ],
  ),
```

#### Image Properties Section

```dart
_DetailSection(
  title: 'Image Properties',
  children: [
    if (details.exifData?.colorSpace != null)
      _DetailRow(
        label: 'Color Space',
        value: details.exifData!.colorSpace!,
      ),
    if (details.exifData?.xResolution != null)
      _DetailRow(
        label: 'Resolution',
        value: '${details.exifData!.xResolution} DPI',
      ),
  ],
),
```

---

## Privacy Controls UI

### Metadata Visibility Toggle

Add toggle switch in media detail page settings:

```dart
SwitchListTile(
  title: const Text('Show Metadata'),
  subtitle: const Text('Display camera, technical, and keyword information'),
  value: details.metadataVisible,
  onChanged: (value) => _updateMetadataVisibility(metadataVisible: value),
),
```

### Location Visibility Toggle

Add conditional toggle for location (only shown if GPS data exists in EXIF or video):

```dart
if (details.exifData?.gps != null || details.videoMetadata?.gps != null)
  SwitchListTile(
    title: const Text('Show Location'),
    subtitle: const Text('Display GPS location information'),
    value: details.locationVisible,
    onChanged: (value) => _updateMetadataVisibility(locationVisible: value),
  ),
```

### Granular Field-Level Visibility Controls

Add expandable section for granular control:

```dart
ExpansionTile(
  title: const Text('Advanced Visibility Settings'),
  subtitle: const Text('Select which metadata fields are visible'),
  children: [
    // EXIF Field Groups
    if (details.exifData != null) ...[
      _VisibilityGroup(
        title: 'Camera Information',
        fields: [
          _VisibilityField(
            label: 'Camera Make & Model',
            value: details.metadataVisibilitySettings?.exif?.cameraInfo ?? true,
            onChanged: (value) => _updateGranularVisibility(
              'exif.cameraInfo',
              value,
            ),
          ),
        ],
      ),
      _VisibilityGroup(
        title: 'Camera Settings',
        fields: [
          _VisibilityField(
            label: 'ISO, Aperture, Shutter Speed',
            value: details.metadataVisibilitySettings?.exif?.cameraSettings ?? true,
            onChanged: (value) => _updateGranularVisibility(
              'exif.cameraSettings',
              value,
            ),
          ),
        ],
      ),
      _VisibilityGroup(
        title: 'Date & Time',
        fields: [
          _VisibilityField(
            label: 'Date Taken',
            value: details.metadataVisibilitySettings?.exif?.dateTime ?? true,
            onChanged: (value) => _updateGranularVisibility(
              'exif.dateTime',
              value,
            ),
          ),
        ],
      ),
      _VisibilityGroup(
        title: 'Location',
        fields: [
          _VisibilityField(
            label: 'GPS Coordinates',
            value: details.metadataVisibilitySettings?.exif?.location ?? details.locationVisible,
            onChanged: (value) => _updateGranularVisibility(
              'exif.location',
              value,
            ),
          ),
        ],
      ),
    ],

    // IPTC Field Groups
    if (details.iptcData != null) ...[
      _VisibilityGroup(
        title: 'Keywords',
        fields: [
          _VisibilityField(
            label: 'Keywords & Tags',
            value: details.metadataVisibilitySettings?.iptc?.keywords ?? true,
            onChanged: (value) => _updateGranularVisibility(
              'iptc.keywords',
              value,
            ),
          ),
        ],
      ),
      _VisibilityGroup(
        title: 'Copyright',
        fields: [
          _VisibilityField(
            label: 'Copyright Information',
            value: details.metadataVisibilitySettings?.iptc?.copyright ?? true,
            onChanged: (value) => _updateGranularVisibility(
              'iptc.copyright',
              value,
            ),
          ),
        ],
      ),
    ],

    // Video Metadata Field Groups
    if (details.videoMetadata != null) ...[
      _VisibilityGroup(
        title: 'Video Information',
        fields: [
          _VisibilityField(
            label: 'Technical Details (Codec, Frame Rate)',
            value: details.metadataVisibilitySettings?.video?.technical ?? true,
            onChanged: (value) => _updateGranularVisibility(
              'video.technical',
              value,
            ),
          ),
          _VisibilityField(
            label: 'Device Information',
            value: details.metadataVisibilitySettings?.video?.device ?? true,
            onChanged: (value) => _updateGranularVisibility(
              'video.device',
              value,
            ),
          ),
        ],
      ),
    ],
  ],
),
```

### Update Handler

```dart
Future<void> _updateMetadataVisibility({
  bool? metadataVisible,
  bool? locationVisible,
  Map<String, dynamic>? metadataVisibilitySettings,
}) async {
  try {
    final useCase = ref.read(updateMediaMetadataVisibilityUseCaseProvider);
    await useCase(
      widget.mediaId,
      metadataVisible: metadataVisible,
      locationVisible: locationVisible,
      metadataVisibilitySettings: metadataVisibilitySettings,
    );

    // Reload media details to get updated state
    await _loadMediaDetails();
  } catch (e) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Failed to update metadata visibility: $e')),
    );
  }
}

Future<void> _updateGranularVisibility(
  String fieldPath,
  bool value,
) async {
  // Parse field path (e.g., "exif.cameraInfo")
  final parts = fieldPath.split('.');
  if (parts.length != 2) return;

  final category = parts[0]; // "exif", "iptc", or "video"
  final field = parts[1]; // "cameraInfo", "keywords", etc.

  // Get current settings
  final current = details.metadataVisibilitySettings ?? {};
  final categorySettings = Map<String, dynamic>.from(current[category] ?? {});

  // Update field
  categorySettings[field] = value;

  // Update settings
  final updated = Map<String, dynamic>.from(current);
  updated[category] = categorySettings;

  await _updateMetadataVisibility(
    metadataVisibilitySettings: updated,
  );
}
```

---

## Data Model Updates

### MediaDetails Entity Extension

Update the `MediaDetails` entity to include all metadata types:

```dart
class MediaDetails {
  // ... existing fields ...

  final EXIFData? exifData;
  final IPTCData? iptcData;
  final VideoMetadata? videoMetadata;
  final String? dateTaken; // Unified date from EXIF or video
  final bool metadataVisible;
  final bool locationVisible;
  final MetadataVisibilitySettings? metadataVisibilitySettings; // Granular field-level control

  // ... rest of fields ...
}

class MetadataVisibilitySettings {
  final EXIFVisibilitySettings? exif;
  final IPTCVisibilitySettings? iptc;
  final VideoVisibilitySettings? video;
}

class EXIFVisibilitySettings {
  final bool? cameraInfo;
  final bool? cameraSettings;
  final bool? dateTime;
  final bool? location;
  final bool? imageProperties;
  final bool? advanced;
}

class IPTCVisibilitySettings {
  final bool? keywords;
  final bool? copyright;
  final bool? descriptive;
  final bool? creator;
}

class VideoVisibilitySettings {
  final bool? dateTime;
  final bool? location;
  final bool? technical;
  final bool? device;
}

class EXIFData {
  final String? make;
  final String? model;
  final String? software;
  final int? orientation;

  final int? iso;
  final double? aperture;
  final String? shutterSpeed;
  final double? focalLength;
  final bool? flash;
  final String? whiteBalance;

  final String? dateTimeOriginal;
  final String? dateTimeDigitized;

  final GPSData? gps;

  final String? colorSpace;
  final Resolution? resolution;
  final double? xResolution;
  final double? yResolution;

  final String? exposureMode;
  final String? meteringMode;
  final String? lensModel;
  final String? artist;
  final String? copyright;
}

class IPTCData {
  final List<String>? keywords;
  final String? copyright;
  final String? copyrightOwner;
  final String? rightsUsageTerms;
  final String? caption;
  final String? headline;
  final String? description;
  final String? creator;
  final String? creatorContact;
  final String? credit;
}

class VideoMetadata {
  final String? dateTimeOriginal;
  final String? dateTimeDigitized;
  final GPSData? gps;
  final String? codec;
  final double? frameRate;
  final int? bitrate;
  final int? duration;
  final String? make;
  final String? model;
}

class GPSData {
  final double? latitude;
  final double? longitude;
  final double? altitude;
  final String? location;
}

class Resolution {
  final int width;
  final int height;
}
```

---

## Formatting Helpers

### Date Formatting

```dart
String _formatDateTime(String isoString) {
  final dateTime = DateTime.parse(isoString);
  final dateFormat = DateFormat('MMMM d, yyyy \'at\' h:mm a');
  return dateFormat.format(dateTime);
}
```

### Shutter Speed Formatting

Shutter speed is already formatted by backend (e.g., "1/125", "2"), but can add display formatting:

```dart
String _formatShutterSpeed(String? shutterSpeed) {
  if (shutterSpeed == null) return '';
  // Backend already formats as "1/125" or "2"
  return shutterSpeed;
}
```

### Aperture Formatting

```dart
String _formatAperture(double? aperture) {
  if (aperture == null) return '';
  return 'f/${aperture.toStringAsFixed(1)}';
}
```

### Bitrate Formatting

```dart
String _formatBitrate(int bitrate) {
  if (bitrate < 1000) {
    return '$bitrate bps';
  } else if (bitrate < 1000000) {
    return '${(bitrate / 1000).toStringAsFixed(1)} Kbps';
  } else {
    return '${(bitrate / 1000000).toStringAsFixed(1)} Mbps';
  }
}
```

---

## Empty States

### No Metadata

If media has no metadata, show a message:

```dart
if (details.exifData == null &&
    details.iptcData == null &&
    details.videoMetadata == null)
  Padding(
    padding: const EdgeInsets.all(16),
    child: Text(
      'No metadata available for this media',
      style: theme.textTheme.bodyMedium?.copyWith(
        color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
      ),
    ),
  ),
```

### Metadata Hidden

If user has hidden metadata:

```dart
if (!details.metadataVisible &&
    (details.exifData != null ||
     details.iptcData != null ||
     details.videoMetadata != null))
  Padding(
    padding: const EdgeInsets.all(16),
    child: Text(
      'Metadata is hidden. Enable it in settings to view camera and technical information.',
      style: theme.textTheme.bodyMedium?.copyWith(
        color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
      ),
    ),
  ),
```

---

## Loading States

### EXIF Data Loading

EXIF data loads with media details, so no separate loading state needed. If EXIF extraction is slow, it's handled during upload, not on detail page load.

---

## Error Handling

### Metadata Visibility Update Failure

```dart
try {
  await _updateMetadataVisibility(metadataVisible: value);
} catch (e) {
  // Show error message
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text('Failed to update metadata visibility'),
      action: SnackBarAction(
        label: 'Retry',
        onPressed: () => _updateMetadataVisibility(metadataVisible: value),
      ),
    ),
  );
}
```

---

## Accessibility

### Screen Reader Support

- All EXIF fields should have semantic labels
- Toggle switches should announce state changes
- Location data should be clearly labeled as sensitive

### Keyboard Navigation

- Toggle switches should be keyboard accessible
- EXIF sections should be navigable with keyboard
- Focus management when toggling visibility

---

## Responsive Design

### Mobile

- Stack EXIF sections vertically
- Use full width for detail rows
- Compact spacing for smaller screens

### Desktop

- Consider side-by-side layout for some sections
- More generous spacing
- Hover states for interactive elements
