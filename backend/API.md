# Local job-processing API

The NestJS backend is the only endpoint the browser extension calls. It binds to `127.0.0.1:3000` outside Docker; Compose publishes container port 3000 only on the host loopback interface.

## Configuration

Copy `.env.example` to `.env` for direct local development. Important variables:

- `DATABASE_PATH`: durable SQLite file. Compose stores it in the `backend_data` volume.
- `N8N_WEBHOOK_URL`: existing n8n production or test webhook. The backend preserves its `{text, url, links, capturedAt}` contract.
- `API_TOKEN`: optional for a loopback-only setup. When set, send the same value through the extension's Backend API token field. It is required as the `X-API-Key` header.
- `URL_RESOLUTION_TIMEOUT_MS` and `N8N_TIMEOUT_MS`: positive timeout values in milliseconds.

Never publish port 3000 or 5678 on a non-loopback interface without authentication and HTTPS.

## `POST /api/jobs/process`

Request:

```json
{
  "text": "We are hiring. Apply at jobs@example.com",
  "url": "https://www.linkedin.com/feed/update/urn:li:activity:123/",
  "links": ["https://forms.gle/example"],
  "capturedAt": "2026-10-27T12:00:00.000Z"
}
```

The response contains `applicationId`, classification `method`, normalized destinations, and independent `workflows.email` and `workflows.form` objects. Email can be `completed` or `failed`; form remains `pending` until a future patch implements `FormProcessor`. A `duplicate` flag on each workflow indicates that branch was already recorded and was not run again.

## `GET /api/jobs/:applicationId`

Returns the stored classification and workflow statuses. URL-encode application IDs containing colons before constructing the request URL.

## Errors

Errors use this structure:

```json
{
  "error": {"code": "VALIDATION_ERROR", "message": "Request validation failed.", "details": []},
  "timestamp": "2026-10-27T12:00:00.000Z",
  "path": "/api/jobs/process"
}
```
