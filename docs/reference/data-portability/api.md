---
title: Data Export API Reference
description: REST endpoints for creating, tracking, and downloading user data export jobs.
sidebar: API Reference
order: 20
---

# User Data Export API Reference

**Version:** 1.0

The export API runs on the Trellis core API (Express). Authentication is
Cognito JWT (bearer token). The base URL is the consuming application's
API endpoint.

---

## Endpoints

### 1. Create Export Job

Create an asynchronous export job. Returns immediately with a job ID.

**Endpoint:** `POST /user/export`

**Authentication:** Required (Cognito JWT bearer token)

**Request Body:**

```json
{
  "format": "json" | "activitypub"
}
```

**Request Example:**

```bash
# Create JSON export job
curl -X POST "https://api.example.com/user/export" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"format": "json"}'

# Create ActivityPub export job
curl -X POST "https://api.example.com/user/export" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"format": "activitypub"}'
```

**Response:**

**Status Code:** `202 Accepted`

**Response Body:**

```json
{
  "jobId": "export-user123-1234567890",
  "status": "pending",
  "message": "Export job created. Check status at /user/export/status/:jobId",
  "estimatedCompletion": "Within 24 hours"
}
```

---

### 2. Check Export Job Status

Get the current status of an export job.

**Endpoint:** `GET /user/export/status/:jobId`

**Authentication:** Required (Cognito JWT bearer token)

**Request Example:**

```bash
curl "https://api.example.com/user/export/status/export-user123-1234567890" \
  -H "Authorization: Bearer $JWT"
```

**Response:**

**Status Code:** `200 OK`

**Response Body:**

```json
{
  "jobId": "export-user123-1234567890",
  "userId": "user-id",
  "email": "user@example.com",
  "format": "json",
  "status": "pending" | "processing" | "completed" | "failed",
  "createdAt": "2025-01-15T10:00:00Z",
  "startedAt": "2025-01-15T10:05:00Z",
  "completedAt": "2025-01-15T10:30:00Z",
  "failedAt": null,
  "error": null,
  "fileKey": "exports/user123/job-id/filename.json",
  "expiresAt": "2025-01-22T10:00:00Z"
}
```

---

### 3. Download Export File

Download the completed export file. Only available when status is `completed`.

**Endpoint:** `GET /user/export/download/:jobId`

**Authentication:** Required (Cognito JWT bearer token)

**Request Example:**

```bash
curl "https://api.example.com/user/export/download/export-user123-1234567890" \
  -H "Authorization: Bearer $JWT" \
  --output export.json
```

**Response:**

**Status Code:** `200 OK`

**Headers:**

```
Content-Type: application/json
Content-Disposition: attachment; filename="export-json-2025-01-15.json"
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

**500 Internal Server Error**

```json
{
  "error": "Failed to export user data",
  "message": "Detailed error message"
}
```

---

## Client Usage

The flow is: call `POST /user/export`, poll
`GET /user/export/status/:jobId` until `completed`, then fetch
`GET /user/export/download/:jobId` and save the returned file. Any HTTP
client following the same poll-then-download sequence works.

---

## Rate Limiting

Rate limiting is applied to prevent abuse.

**Limits:**

- 10 exports per hour per user
- 100 exports per day per user

---

## Security

### Authentication

- Cognito JWT bearer-token authentication required
- The token must be valid and unexpired
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
curl -X POST "https://api.example.com/user/export" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"format": "json"}'
# poll status, then download and validate the JSON with: jq . export.json
```

**Test ActivityPub export:** same flow with `{"format": "activitypub"}`.

---

## Related Documentation

- [Data Format](./data-format/README.md)
- [Data Portability Overview](./README.md)
