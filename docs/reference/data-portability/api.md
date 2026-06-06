---
title: Data Export API Reference
description: REST endpoints for creating, tracking, and downloading user data export jobs.
sidebar: API Reference
order: 20
---

# User Data Export API Reference

**Version:** 1.0

The export API runs on the Trellis core API. Authentication is via
the encrypted session cookie (the same session used by the rest of the user
API); state-changing requests also require the CSRF token. The base URL is the
consuming application's API endpoint.

---

## Endpoints

### 1. Create Export Job

Create an asynchronous export job. Returns immediately with a job ID.

**Endpoint:** `POST /api/user/export`

**Authentication:** Required (session cookie + CSRF token)

**Request Body:**

```json
{
  "format": "json" | "atproto"
}
```

`format` defaults to `"json"` when omitted or unrecognised.

**Request Example:**

```bash
# Create JSON export job
curl -X POST "https://api.example.com/api/user/export" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF" \
  --cookie "$SESSION_COOKIE" \
  -d '{"format": "json"}'

# Create AT Protocol export job
curl -X POST "https://api.example.com/api/user/export" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF" \
  --cookie "$SESSION_COOKIE" \
  -d '{"format": "atproto"}'
```

**Response:**

**Status Code:** `202 Accepted`

**Response Body:**

```json
{
  "jobId": "export-user123-1234567890",
  "status": "pending",
  "message": "Export job created. Check status at /api/user/export/status/:jobId",
  "estimatedCompletion": "Within 24 hours"
}
```

---

### 2. Check Export Job Status

Get the current status of an export job.

**Endpoint:** `GET /api/user/export/status/:jobId`

**Authentication:** Required (session cookie)

**Request Example:**

```bash
curl "https://api.example.com/api/user/export/status/export-user123-1234567890" \
  --cookie "$SESSION_COOKIE"
```

**Response:**

**Status Code:** `200 OK`

The status endpoint returns the stored job record. Optional fields
(`startedAt`, `completedAt`, `failedAt`, `error`, `fileKey`) are present only
once the relevant lifecycle stage has been reached.

**Response Body:**

```json
{
  "jobId": "export-user123-1234567890",
  "userId": "user-id",
  "email": "user@example.com",
  "format": "json",
  "status": "pending",
  "region": "EU",
  "createdAt": "2025-01-15T10:00:00Z",
  "startedAt": "2025-01-15T10:05:00Z",
  "completedAt": "2025-01-15T10:30:00Z",
  "fileKey": "exports/user123/job-id/filename.json",
  "expiresAt": "2025-01-22T10:00:00Z"
}
```

`status` is one of `pending`, `processing`, `completed`, or `failed`. A
not-found or non-owned job returns `404`.

---

### 3. Download Export File

Download the completed export file. Only available when status is `completed`.

**Endpoint:** `GET /api/user/export/download/:jobId`

**Authentication:** Required (session cookie)

**Request Example:**

```bash
curl "https://api.example.com/api/user/export/download/export-user123-1234567890" \
  --cookie "$SESSION_COOKIE" \
  --output export.json
```

**Response:**

**Status Code:** `200 OK`

**Headers:**

```
Content-Type: application/json
Content-Disposition: attachment; filename="trellis-export-json-2025-01-15.json"
Cache-Control: private, no-cache
```

**Response Body:**
JSON file containing all user data (see [Data Format](./data-format/README.md) for structure)

**Error Responses:**

**401 Unauthorized**

```json
{
  "error": "Unauthorized"
}
```

**404 Not Found** (file not ready, job not found, or not owned by the caller)

```json
{
  "error": "Export file not found or not ready"
}
```

**500 Internal Server Error**

```json
{
  "error": "Failed to download export file",
  "message": "Detailed error message"
}
```

---

## Client Usage

The flow is: call `POST /api/user/export`, poll
`GET /api/user/export/status/:jobId` until `completed`, then fetch
`GET /api/user/export/download/:jobId` and save the returned file. Any HTTP
client following the same poll-then-download sequence works.

---

## Security

### Authentication

- A valid session cookie is required; state-changing requests
  (`POST /api/user/export`) also require the CSRF token
- Only authenticated users can export their data

### Authorization

- Users can only export their own data
- No access to other users' data
- Server-side validation enforces data isolation

### Data Privacy

- The export includes the requesting user's own data only
- Private posts are included (user's own)
- No sensitive system data is exposed

---

## Performance

### Job Creation

- **Response Time**: < 1 second (immediate)
- **Impact**: none on the live application

### Export Processing

- **Processing Time**: 5–30 minutes (background)
- **Total Time**: up to 24 hours
- **Impact**: none on the live application (async processing)

### File Size

- Small accounts: < 100 KB
- Medium accounts: 100 KB – 1 MB
- Large accounts: 1 MB – 10 MB+
- Very large accounts: 10 MB – 100 MB+

---

## Error Codes

| Status Code | Error                 | Description                                    |
| ----------- | --------------------- | ---------------------------------------------- |
| 202         | Accepted              | Export job created successfully                |
| 200         | Success               | Status check or download successful            |
| 401         | Unauthorized          | User not authenticated                         |
| 404         | Not Found             | Job not found or file not ready                |
| 500         | Internal Server Error | Server error during job creation or processing |

---

## Testing

**Test standard export:**

```bash
curl -X POST "https://api.example.com/api/user/export" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF" \
  --cookie "$SESSION_COOKIE" \
  -d '{"format": "json"}'
# poll status, then download and validate the JSON with: jq . export.json
```

**Test AT Protocol export:** same flow with `{"format": "atproto"}`.

---

## Related Documentation

- [Data Format](./data-format/README.md)
- [Data Portability Overview](./README.md)
