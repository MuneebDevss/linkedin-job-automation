# Local job-processing API

The NestJS backend is the only endpoint the browser extension calls. It binds to `127.0.0.1:3000` outside Docker; Compose publishes container port 3000 only on the host loopback interface.

## Configuration

Copy `.env.example` to `.env` for direct local development and Compose. Compose loads `backend/.env` through its backend `env_file` declaration. Important variables:

- `DATABASE_PATH`: durable SQLite file. Compose stores it in the `backend_data` volume.
- `N8N_WEBHOOK_URL`: existing n8n production or test webhook. The backend adds durable `workflowId` and `idempotencyKey` fields to the original payload.
- `API_TOKEN`: optional for a loopback-only setup. When set, send the same value through the extension's Backend API token field. It is required as the `X-API-Key` header.
- `URL_RESOLUTION_TIMEOUT_MS` and `N8N_TIMEOUT_MS`: positive timeout values in milliseconds.
- `FORM_AUTOMATION_ENABLED` and `FORM_AUTO_SUBMIT`: both must be true before a form can be submitted.
- `FORM_TIMEOUT_MS`, `FORM_NAVIGATION_TIMEOUT_MS`, `FORM_MAX_RETRIES`, and `FORM_MAX_PAGES`: bounded browser-operation limits.
- `FORM_ARTIFACTS_DIRECTORY`: screenshots for failures or manual-action outcomes.
- `RESUME_DIRECTORY`: the only directory from which the browser may upload a resume. Resume catalog file names are resolved inside this directory.
- `APPLICATION_DOCUMENTS_DIRECTORY`: the only directory from which explicitly cataloged non-resume documents may be uploaded.
- `FORM_AUTH_STATE_PATH`: permission-restricted Playwright cookie/storage state reused by isolated job contexts.
- `FORM_AUTH_LOGIN_URL` and `FORM_AUTH_LOGIN_TIMEOUT_MS`: trusted HTTPS login entry point and time allowed for the one-time interactive sign-in.
- `FORM_AUTH_CDP_URL`: optional, desktop-only, unauthenticated loopback HTTP origin for attaching to a separately launched Chrome instance with a dedicated profile. Do not configure or expose it in Docker.
- `PLAYWRIGHT_HEADLESS`: keep enabled for normal backend operation. `PLAYWRIGHT_BROWSER_EXECUTABLE_PATH` can select an explicitly managed Chromium build.
- `FORM_ALLOW_LOCALHOST`: exists for mock-form tests only and must remain false in normal operation.
- `BATCH_CONCURRENCY`, `EMAIL_WORKFLOW_CONCURRENCY`, and `FORM_WORKFLOW_CONCURRENCY`: independent queue limits. Keep form concurrency low because each form uses a browser context.
- `QUEUE_POLL_INTERVAL_MS` and `QUEUE_LEASE_MS`: durable SQLite queue polling and crash-recovery lease settings.
- `WORKFLOW_RETRY_LIMIT`: maximum attempts accepted by the retry API.
- `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEETS_TAB`, and read-only credentials are optional and used only by the one-time legacy import. New tracking never reads from or writes to Sheets.

Never publish port 3000 or 5678 on a non-loopback interface without authentication and HTTPS.

## `POST /api/jobs/process`

Request:

```json
{
  "text": "We are hiring. Apply at jobs@example.com",
  "url": "https://www.linkedin.com/feed/update/urn:li:activity:123/",
  "links": ["https://forms.gle/example"],
  "capturedAt": "2026-10-27T12:00:00.000Z",
  "company": "Example Ltd (optional)",
  "role": "Backend Developer (optional)",
  "location": "Islamabad (optional)"
}
```

The response contains `applicationId`, classification `method`, normalized destinations, and independent `workflows.email` and `workflows.form` objects. The email and form branches run independently, so a failure in one does not stop the other. A `duplicate: true` flag means a previously completed outcome was reused. A repeated request atomically retries an email workflow whose durable status is `failed`; completed or currently processing email workflows are not started again. Retry-safe form outcomes in `failed` or `needs_manual_action` are also run again and return `duplicate: false`; form outcomes where submission already started are never retried automatically.

For a supported Google Forms URL, the form workflow creates a fresh isolated Playwright browser context, inspects one page at a time, asks the profile engine for answers, selects the matching resume, validates the page, follows `Next`, and submits the final page. Its terminal statuses are:

- `completed`: a Google Forms confirmation message or confirmation container was detected after submission;
- `needs_manual_action`: automation stopped safely before submission for CAPTCHA, authentication, a closed form, an unsupported or unresolved required field, missing legal consent, or failed validation;
- `submission_unknown`: Submit was clicked but confirmation could not be established, or the browser failed after submission began; this status is never retried automatically;
- `failed`: browser infrastructure or navigation failed after bounded retries.

The backend does not treat clicking Submit as success. A post-click response with no reliable confirmation becomes `submission_unknown`, avoiding an accidental duplicate submission.

Google Forms support includes short/long text, numeric and date inputs, radio buttons, checkboxes, native and Google-style dropdowns, multi-page navigation, and file uploads. Other form platforms intentionally return `needs_manual_action` through the adapter registry until a dedicated adapter is added.

CAPTCHAs are detected but never bypassed. Authentication-required forms reuse the saved browser session described below. Required legal declarations, fees, purchases, payment details, and financial commitments are not sent to Gemini and are accepted only when the normalized question text is explicitly set to `true` under `verified.automationConsents.legalDeclarations` in `data/profile.json`. Automatic submission also requires `verified.automationConsents.automaticSubmission: true`.

Example legal consent configuration (use the normalized lower-case label shown by the form):

```json
{
  "automationConsents": {
    "automaticSubmission": true,
    "legalDeclarations": {
      "i certify that all information is accurate": true
    }
  }
}
```

Screenshots are captured for actionable failures and stored under one job-specific folder. The original audit object remains in the form workflow's `response`, while SQLite also stores the latest normalized question/answer state and an immutable record for every form attempt. Stored answer sources are normalized to `profile`, `derived`, `approved_memory`, `gemini`, `attachment`, or `consent`.

### Persistent authentication

Google can reject a browser launched under Playwright control even when it uses the stable Chrome executable. For Google authentication, first launch normal Chrome from the `backend` directory with an application-only profile:

```bash
mkdir -p data/chrome-auth-profile
google-chrome-stable \
  --user-data-dir="$PWD/data/chrome-auth-profile" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  https://accounts.google.com/
```

Complete login manually, then capture the resulting session from another terminal:

```bash
cd backend
FORM_AUTH_CDP_URL=http://127.0.0.1:9222 npm run auth:form
```

Use `google-chrome` or `chromium` if that is the Fedora executable name. Never point `--user-data-dir` at an everyday Chrome profile. The backend never asks for or receives a password. After a current Google session cookie—or a completed configured SSO login—is detected, Playwright saves cookies and origin storage atomically with mode `0600` at `FORM_AUTH_STATE_PATH`. Treat the dedicated profile and state file as secrets and do not commit or share them. The dedicated profile is deliberately outside `data/playwright`, so Compose mounts only the compact storage-state directory rather than the complete Chrome profile.

`npm run auth:form` without `FORM_AUTH_CDP_URL` remains backward compatible and opens a Playwright-managed browser. Use it only where the identity provider accepts that browser. A Google `/signin/rejected` response is reported as a failed authentication and is never saved as valid state.

Compose bind-mounts `backend/data/playwright` at the same container path, so a session created by the desktop CLI is available to the container. Run the CLI before starting Compose, or stop the backend container while refreshing the session. Do not pass `FORM_AUTH_CDP_URL` into Compose; the CDP endpoint is deliberately loopback-only and used only during desktop capture.

Each job still receives a new isolated browser context; the saved storage state is copied into that context. If a protected form redirects back to login, the workflow returns `reauthentication_required` instead of repeatedly retrying. Repeat the dedicated-profile capture to refresh it. Google may revoke a cookie before its local expiry time, which can only be detected when a protected form rejects it.

The same flow is exposed to authenticated local clients as:

- `GET /api/forms/auth/status` — returns `missing`, `available`, `expired`, or `invalid`;
- `POST /api/forms/auth/session` — starts the configured interactive flow (managed browser or external CDP attachment) and waits for sign-in;
- `POST /api/forms/auth/google` — compatibility alias for the same operation.

For Google Workspace SSO, set `FORM_AUTH_LOGIN_URL` to the trusted HTTPS login entry page. Cookies from the completed redirect chain are stored, allowing the form context to reuse both Google and identity-provider sessions.

### Upload catalogs

Resume-labeled fields use the existing role-matched `resumeCatalog`. Other upload fields never receive a resume by guesswork. To allow an existing cover letter, transcript, portfolio PDF, or similar document, add it to `documentCatalog`:

```json
{
  "id": "transcript",
  "fileName": "Muneeb_Transcript.pdf",
  "path": "/files/resumes/Muneeb_Transcript.pdf",
  "labels": ["transcript", "academic transcript"]
}
```

The file must exist inside `APPLICATION_DOCUMENTS_DIRECTORY`. Before submission, the adapter verifies the selected filename is present in the file input or Google Forms upload UI and that no upload progress indicator remains.

## Dashboard and durable batch APIs

- `POST /api/jobs/batches` — validates and persists 1–100 entries, then returns `202` with the batch ID before work starts. Optional `concurrency` is bounded by backend configuration and `idempotencyKey` deduplicates repeated submissions.
- `GET /api/jobs/batches` and `GET /api/jobs/batches/:batchId` — persistent batch history, counters, inputs, application IDs, results, errors, and retries.
- `POST /api/jobs/batches/:batchId/retry` — creates a new batch containing only failures that NestJS determines are safe to retry.
- `GET /api/jobs/dashboard` — SQLite-backed application/workflow/batch totals plus recent activity.
- `GET /api/jobs/applications` — searchable, filterable, sortable, paginated application list.
- `GET /api/jobs/failures` — failed/manual/unknown workflows with server-computed retry eligibility.
- `POST /api/jobs/workflows/:workflowId/retry` — queues one eligible workflow with bounded exponential backoff.
- `GET /api/jobs/events?after=<id>` — efficient event polling. Events contain real stages, never fabricated percentages.
- `GET /api/jobs/health` — local backend, queue, and SQLite connection status.
- `POST /api/jobs/import/google-sheets` — optional one-time read-only import of legacy tracker rows. Imported rows are never executed as new applications.

Queued work survives browser refreshes and backend restarts. Expired queue leases are reclaimed. Interrupted email draft creation becomes `needs_manual_action` because a draft may already exist; a form interrupted during submission/verification becomes `submission_unknown`. Neither is retried automatically.

## `GET /api/jobs/:applicationId`

Returns job metadata and timestamps, original LinkedIn and application URLs, selected resume, independent workflow statuses, normalized form questions/answers, submission evidence, immutable workflow/form attempts, processing events, errors, request/response payloads, and durations. URL-encode application IDs containing colons before constructing the request URL. The legacy `sheetsSync` field may be present only for backward-compatible historical records and is never updated for new applications.

## `POST /api/forms/answers`

Generates answers without invoking browser automation. The request contains a job context and 1–100 questions. Supported `type` values are `text`, `number`, `date`, `radio`, `checkbox`, `select`, and `long_text`.

See [the sample request](examples/form-answers.input.json) and [sample response](examples/form-answers.output.json). The response always follows this priority:

1. verified values from `data/profile.json`;
2. approved, compatible reusable answers;
3. deterministic derivation;
4. Gemini;
5. an explicit unresolved answer with a `null` value.

Each answer includes its original question ID, validated value, confidence, and provenance. Gemini receives only unresolved questions plus the job description, verified profile structure, and the selected resume metadata. Malformed Gemini output is rejected locally.

Salary questions require an identifiable seniority, currency, and `monthly` or `annual` period. The engine uses only the exact matching profile amount, or records an explicit ×12/÷12 deterministic derivation. It never performs an exchange-rate conversion. Unknown salary values stay unresolved and Gemini is instructed not to invent them.

Accepted medium/high-confidence Gemini answers are atomically appended to `generatedSuggestions` with `approved: true` and reused before another model call when their question type and compatibility rules match. Model-marked reusable answers may cross compatible jobs; non-reusable answers are restricted to the exact job fingerprint. Low-confidence, malformed, or ungrounded answers are not persisted. Generated answers never overwrite `verified` fields. Salary, availability dates, identity, and other factual values remain grounded in verified profile fields and deterministic rules rather than model invention.

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
