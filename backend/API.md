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

## `POST /api/forms/answers`

Generates answers only; it does not open a browser, fill a form, or submit an application. The request contains a job context and 1–100 questions. Supported `type` values are `text`, `number`, `date`, `radio`, `checkbox`, `select`, and `long_text`.

See [the sample request](examples/form-answers.input.json) and [sample response](examples/form-answers.output.json). The response always follows this priority:

1. verified values from `data/profile.json`;
2. approved, compatible reusable answers;
3. deterministic derivation;
4. Gemini;
5. an explicit unresolved answer with a `null` value.

Each answer includes its original question ID, validated value, confidence, and provenance. Gemini receives only unresolved questions plus the job description, verified profile structure, and the selected resume metadata. Malformed Gemini output is rejected locally.

Salary questions require an identifiable seniority, currency, and `monthly` or `annual` period. The engine uses only the exact matching profile amount, or records an explicit ×12/÷12 deterministic derivation. It never performs an exchange-rate conversion. Unknown salary values stay unresolved and Gemini is instructed not to invent them.

Gemini-generated reusable answers are atomically appended to `generatedSuggestions` with `approved: false`. To reuse one, review it in `data/profile.json`, move it to `approvedReusableAnswers`, and set `approved` to `true`. Generated answers never overwrite `verified` fields.

The profile engine uses:

- `PROFILE_PATH` and `PROFILE_TEMPLATE_PATH` for profile storage and first-run initialization;
- `GEMINI_API_KEY` for credentials;
- `GEMINI_MODEL` for the model name;
- `GEMINI_TIMEOUT_MS` for the request deadline.

## Errors

Errors use this structure:

```json
{
  "error": {"code": "VALIDATION_ERROR", "message": "Request validation failed.", "details": []},
  "timestamp": "2026-10-27T12:00:00.000Z",
  "path": "/api/jobs/process"
}
```
