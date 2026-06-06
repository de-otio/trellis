---
title: File Naming Convention
description: Naming patterns for exported user data files across JSON and ActivityPub formats.
sidebar: File Naming
order: 40
---

# File Naming Convention

This document describes the naming conventions for exported user data files.

---

## Standard JSON Format

Files exported in standard JSON format follow this pattern:

```
export-json-YYYY-MM-DD.json
```

**Example:**

- `export-json-2025-01-15.json`

A consuming application may prefix the filename with its own product name
(for example `<app>-export-json-2025-01-15.json`).

---

## ActivityPub Format

Files exported in ActivityPub format follow this pattern:

```
export-activitypub-YYYY-MM-DD.json
```

**Example:**

- `export-activitypub-2025-01-15.json`

---

## Naming Components

### Prefix

- `export-` — identifies the file as a data export (optionally preceded by the product name)

### Format Identifier

- `json` — standard JSON format
- `activitypub` — ActivityPub format

### Date

- `YYYY-MM-DD` — ISO 8601 date format (year-month-day)
- Date represents when the export was generated

### Extension

- `.json` — JSON file format

---

## File Download

When users download their data export:

1. The file is generated with the current date
2. The format (json/activitypub) is determined by the user's selection
3. The file is named according to the convention above
4. The file is provided as a download or stored in cloud storage

---

## Multiple Exports

If a user requests multiple exports on the same day:

- Each export will have the same date in the filename
- The system may append additional identifiers (e.g., timestamps) if needed
- Users should rename files if they want to distinguish between multiple exports

---

## Related Documentation

- [Standard JSON Format](./standard-json-format.md)
- [Back to Format Specification](./README.md)
