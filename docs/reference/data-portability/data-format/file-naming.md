---
title: File Naming Convention
description: Naming patterns for exported user data files across the JSON and AT Protocol formats.
sidebar: File Naming
order: 40
---

# File Naming Convention

This document describes the naming conventions for exported user data files.

---

## Standard JSON Format

Files exported in standard JSON format follow this pattern:

```
trellis-export-json-YYYY-MM-DD.json
```

**Example:**

- `trellis-export-json-2025-01-15.json`

---

## AT Protocol Format

Files exported in AT Protocol format follow this pattern:

```
trellis-export-atproto-YYYY-MM-DD.json
```

**Example:**

- `trellis-export-atproto-2025-01-15.json`

---

## Naming Components

### Prefix

- `trellis-export-` — identifies the file as a Trellis data export

### Format Identifier

- `json` — standard JSON format
- `atproto` — AT Protocol format

### Date

- `YYYY-MM-DD` — ISO 8601 date format (year-month-day)
- Date represents when the export was generated

### Extension

- `.json` — JSON file format

---

## File Download

When users download their data export:

1. The file is generated with the current date (the date the export is produced)
2. The format (json/atproto) is determined by the user's selection
3. The file is named according to the convention above
4. The file is stored in object storage and served as an attachment download

---

## Multiple Exports

If a user requests multiple exports on the same day:

- Each export's **download filename** carries the same date, so downloaded
  files share a name
- Server-side these do **not** collide: each export is stored under a job-scoped
  object key (`exports/{userId}/{jobId}/{filename}`), and the job ID embeds a
  creation timestamp
- Users should rename downloaded files locally if they want to distinguish
  between multiple same-day exports

---

## Related Documentation

- [Standard JSON Format](./standard-json-format.md)
- [Back to Format Specification](./README.md)
