---
title: Export Format Specification Overview
description: Overview of the two export format variants — standard JSON and AT Protocol — and links to each sub-document.
sidebar: Overview
order: 10
---

# User Data Export Format Specification

**Version:** 1.0

---

## Overview

This specification describes the exact format of exported user data. The export
is provided in JSON with two variants, selected by the `format` request
parameter:

1. **Standard JSON format** (`format: "json"`) — human-readable,
   general-purpose format
2. **AT Protocol format** (`format: "atproto"`) — an AT Protocol-compatible
   transform of the standard data, where posts and comments are re-keyed into
   AT Protocol lexicon records (`$type` records such as `com.trellis.dog.post`
   and `com.trellis.dog.comment`, with media as `$type: "blob"` references)

The AT Protocol format reuses the standard JSON object shapes plus the
identity fields described in
[Standard JSON Format](./standard-json-format.md); there is no separate
format document.

---

## Documentation Structure

- **[Standard JSON Format](./standard-json-format.md)** — Complete specification for the standard JSON export format
- **[Data Completeness](./data-completeness.md)** — What data is included and excluded from exports
- **[File Naming Convention](./file-naming.md)** — Naming conventions for export files
- **[Validation](./validation.md)** — Validation rules and required fields
- **[Migration Guide](./migration-guide.md)** — How to import and migrate exported data
- **[Version History](./version-history.md)** — Changelog and version information

---

## Quick Start

For most users, start with:

1. [Standard JSON Format](./standard-json-format.md) — understanding the export structure
2. [Data Completeness](./data-completeness.md) — what you'll receive in the export
3. [Migration Guide](./migration-guide.md) — how to use the exported data

For AT Protocol migration:

1. [Standard JSON Format](./standard-json-format.md) — the object shapes and identity fields
2. [Migration Guide](./migration-guide.md#scenario-3-at-protocol-migration) — migration steps

---

## Related Documentation

- [API Reference](../api.md)
- [Data Portability Overview](../README.md)
