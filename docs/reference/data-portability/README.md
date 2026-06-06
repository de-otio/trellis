---
title: Data Portability
description: User data export — request, track, and download all your content from a Trellis-based platform.
sidebar: Data Portability
order: 10
---

# Data Portability — User Data Export

The user data export feature lets users download all their content from a
Trellis-based platform in a structured, machine-readable format. It supports
data portability, backup, and migration to other services (including
ActivityPub servers).

Exports are processed **asynchronously** to handle large datasets without
impacting application performance. Users may need to wait up to 24 hours for
their export to be ready.

---

## Quick Start

### For Users

1. Navigate to the **Profile** page
2. Scroll to the **Account Actions** section
3. Click **"Request JSON Export"** or **"Request ActivityPub Export"**
4. An export job is created (a status message is shown)
5. The system processes the export in the background (up to 24 hours)
6. The file downloads when ready

### For Developers

API surface (Cognito JWT auth, server-hosted endpoint):

```
POST /user/export             # body: { "format": "json" | "activitypub" }
GET  /user/export/status/:jobId
GET  /user/export/download/:jobId
```

See [API Reference](./api.md) for the full contract.

---

## Documentation

- **[Data Format](./data-format/README.md)** — Export format specification
- **[API Reference](./api.md)** — API endpoint documentation

---

## Features

- **Complete data export** — all user content included
- **Two formats** — JSON and ActivityPub-compatible
- **Async processing** — handles large datasets without blocking
- **Status tracking and auto-download** in the client
- **Secure** — authentication required, only the requester's own data
- **Structured format** — machine-readable JSON
- **24-hour SLA** — exports complete within 24 hours

---

## What's Included

- User profile (id, email, federation identity fields when present)
- All posts (with media metadata, reactions, comments)
- Comments on others' posts
- Reactions on others' content
- Geo-location data
- Post visibility settings
- Content warnings

Domain extensions may attach additional fields (for example a consuming
application's own entity references) without changing the root format.

---

## What's Not Included

- Actual media files (only metadata)
- Deleted posts
- Other users' private content

---

## Use Cases

1. **Data backup** — keep a local backup of content
2. **Data portability** — move data to another service
3. **ActivityPub migration** — migrate to an ActivityPub server
4. **Compliance** — GDPR data access requests (Article 15 / Article 20)
5. **Data analysis** — analyse one's own content
