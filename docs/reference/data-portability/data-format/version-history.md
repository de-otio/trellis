---
title: Export Format Version History
description: Changelog and version information for the Trellis user data export format.
sidebar: Version History
order: 70
---

# Version History

This document tracks changes and version history for the user data export format specification.

---

## Version 1.0

**Initial Release**

### Features

- Standard JSON format
- ActivityPub format
- Basic data export
- User profile information
- Posts, comments, and reactions
- Geo-location data
- Media metadata
- Content warnings
- Post visibility settings

### Format Structure

- Root structure with metadata
- User object
- Posts array
- Comments array
- Reactions/sentiments array
- Geo-indexed posts array

### Limitations

- Media files not included (metadata only)
- Social-graph relationships not included (stored in the graph backend)
- Deleted posts not included
- No incremental export support

---

## Version Compatibility

### Backward Compatibility

- New versions maintain backward compatibility where possible
- Required fields will not be removed
- Optional fields may be added

### Migration Between Versions

- Exports from older versions remain valid
- Newer versions may include additional fields
- Consumers should handle optional fields gracefully

---

## Changelog Format

Each version entry includes:

- **Version number**: semantic version (major.minor.patch)
- **Release date**: when the version was released
- **Features**: new features added
- **Changes**: changes to existing features
- **Breaking changes**: any breaking changes (if applicable)
- **Deprecations**: deprecated features (if applicable)

---

## Related Documentation

- [Standard JSON Format](./standard-json-format.md)
- [Data Completeness](./data-completeness.md)
- [Back to Format Specification](./README.md)
