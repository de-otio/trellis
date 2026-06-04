# Data Portability — User Data Export

**Status:** design — API surface to be wired in the core
**Domain:** technical / GDPR data portability

> **Where this lives.** User data export is a **trellis framework capability** — every consuming application needs GDPR-style data portability. This folder is the canonical design for the export API and the on-disk data format. The format is intentionally domain-neutral: domain extensions (e.g. a consuming application's own entity types) attach their data through extension-defined fields rather than format changes.

---

## Overview

The user data export feature lets users download all their content from a trellis-based platform in a structured, machine-readable format. It supports data portability, backup, and migration to other services (including ActivityPub servers).

**Note:** Exports are processed **asynchronously** to handle large datasets without impacting application performance. Users may need to wait up to 24 hours for their export to be ready.

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

See [API.md](./API.md) for the current contract.

---

## Documentation

- **[Data Format](./data-format/README.md)** - Export format specification
- **[API Reference](./API.md)** - API endpoint documentation

---

## Features

- **Complete data export** - all user content included
- **Two formats** - JSON and ActivityPub-compatible
- **Async processing** - handles large datasets without blocking
- **Background jobs** - processes during off-peak hours
- **Status tracking and auto-download** in the client
- **Secure** - authentication required, only the requester's own data
- **Structured format** - machine-readable JSON
- **24-hour SLA** - exports complete within 24 hours

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

1. **Data backup** - keep a local backup of content
2. **Data portability** - move data to another service
3. **ActivityPub migration** - migrate to an ActivityPub server
4. **Compliance** - GDPR data access requests (Article 15 / Article 20)
5. **Data analysis** - analyse one's own content

---

## Future Enhancements

- [ ] Email notifications when export is ready
- [ ] Media file downloads
- [ ] Compressed exports (gzip)
- [ ] Incremental exports
- [ ] Scheduled automatic exports
- [ ] Export history tracking
- [ ] Multiple format support (CSV, XML)
- [ ] Export cancellation
- [ ] Priority queue for urgent exports

---

## Related Documentation

- [API Reference](./API.md)
- [Data Format](./data-format/README.md)
- [ActivityPub](../architecture/07-activitypub.md) - federation protocol
