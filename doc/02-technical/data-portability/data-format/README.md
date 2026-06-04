# User Data Export Format Specification

**Version:** 1.0

---

## Overview

This specification describes the exact format of exported user data. The export is provided in JSON with two variants:

1. **Standard JSON format**: human-readable, general-purpose format
2. **ActivityPub format**: ActivityPub-compatible format for server migration

---

## Documentation Structure

- **[Standard JSON Format](./standard-json-format.md)** - Complete specification for the standard JSON export format
- **[Data Completeness](./data-completeness.md)** - What data is included and excluded from exports
- **[File Naming Convention](./file-naming.md)** - Naming conventions for export files
- **[Validation](./validation.md)** - Validation rules and required fields
- **[Migration Guide](./migration-guide.md)** - How to import and migrate exported data
- **[Version History](./version-history.md)** - Changelog and version information

The ActivityPub format reuses the standard JSON object shapes plus the
ActivityPub identity fields described in
[Standard JSON Format](./standard-json-format.md); there is no separate
format document.

---

## Quick Start

For most users, start with:

1. [Standard JSON Format](./standard-json-format.md) - understanding the export structure
2. [Data Completeness](./data-completeness.md) - what you'll receive in the export
3. [Migration Guide](./migration-guide.md) - how to use the exported data

For ActivityPub migration:

1. [Standard JSON Format](./standard-json-format.md) - the object shapes and identity fields
2. [Migration Guide](./migration-guide.md#scenario-3-activitypub-server-migration) - server migration steps

---

## Related Documentation

- [API Reference](../API.md)
