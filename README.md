# LinkedIn job automation

The Firefox/Chrome extension captures one selected job post and sends it to a local NestJS backend. The backend normalizes destinations, classifies the application method, stores durable workflow state in SQLite, forwards email applications to the existing n8n webhook, and automatically processes eligible Google Forms with Playwright. Gmail automation is unchanged.

## 1. Start the backend and n8n
Install Docker Engine and the Docker Compose plugin (if missing). In this extracted folder run:

```bash
docker compose up -d --build
```

The backend is available at `http://127.0.0.1:3000`, and n8n remains at `http://127.0.0.1:5678`. Both ports are published only on loopback. The `backend_data` and `n8n_data` volumes are durable; do not delete them unless you intend to remove their data.

Compose loads backend runtime settings, including Gemini credentials, from `backend/.env`. Create it from `backend/.env.example` and keep it private. To require a shared local token, set `BACKEND_API_TOKEN` before starting Compose and enter the same value in the extension. Direct-development variables are documented in [backend/.env.example](backend/.env.example), and the complete API contract is in [backend/API.md](backend/API.md).

## 2. Import the workflow
In n8n create a workflow, use its menu → Import from File → choose workflow.json. Save it. Select the Receive post node and click Listen for test event (or Execute workflow). Use the Test URL shown by the node; it should be http://localhost:5678/webhook-test/linkedin-job. The test listener generally needs re-arming after each request.

For ongoing use publish/activate the workflow. Compose configures the backend to use `http://n8n:5678/webhook/linkedin-job`, preserving the workflow's existing `{text, url, links, capturedAt}` request contract. For test-webhook development outside Compose, set `N8N_WEBHOOK_URL=http://127.0.0.1:5678/webhook-test/linkedin-job` and arm the test listener before each request.

## 3. Load the extension
Firefox: open about:debugging#/runtime/this-firefox → Load Temporary Add-on → choose extension/manifest.json. Temporary add-ons disappear on browser restart; reload when needed. Signing/persistent distribution is a later step.

After updating or reloading the extension, refresh any LinkedIn tabs that were already open before testing selection capture. This ensures those tabs use the latest content script.

Chrome/Chromium: open chrome://extensions → enable Developer mode → Load unpacked → choose the extension folder. Remove browser_specific_settings from manifest.json if your Chromium version objects to that Firefox metadata.

## 4. Capture a real post
Open LinkedIn and expand “see more”, then select the desired job-post text before opening the extension. The popup always accepts non-empty selected text, even when LinkedIn has changed its wrapper markup or the post has no links. When a post container is recognizable, it enriches the selection with the post permalink and scans both visible text and DOM anchors for `https://`, `http://`, `www.`, `mailto:`, and `lnkd.in` links. Otherwise it safely falls back to the current page URL and URLs visible in the selection. The same selection fallback works on other regular HTTP/HTTPS tabs. Verify/edit all fields before sending. On an individual LinkedIn post page, capture can also proceed without a selection when exactly one visible post is detected.

Shortened `lnkd.in` URLs remain visible in the editable preview and are resolved by the backend only after you click Send. Resolution permits only HTTPS, validates DNS results and every redirect destination against private/network-local ranges, limits redirect depth, response size, and duration, and reads LinkedIn's marked external destination from its safety-interstitial page. Failure keeps the original URL.

Click Send. For email applications, the backend invokes n8n and returns the email workflow status. For Google Forms, it creates a durable workflow record, opens an isolated browser context, fills reliable profile-engine answers, uploads the selected resume, validates each page, and submits only when the form is eligible. Combined applications contain independent email and form statuses, so one branch cannot prevent the other from being recorded or executed. Repeated captures are deduplicated independently per branch; a durably failed email workflow is atomically retried by the next identical request, while a completed draft is reused without calling n8n again. SQLite also retains normalized form questions, answer provenance, submission attempts, evidence, and Sheets synchronization state; no per-application JSON files are created.

Form processing can take longer than the email flow. Keep the popup open while Send is running when you want to see the result immediately. The durable status is also available through `GET /api/jobs/:applicationId`.

## Profile-based form answers

The backend exposes `POST /api/forms/answers` for answer generation without browser execution. The same engine is used by Google Forms automation. It matches common question variants, selects a resume from the existing catalog, and applies this strict order: verified profile → approved reusable answer → deterministic derivation → Gemini → unresolved.

Review [the local profile](backend/data/profile.json) before use. Existing supplied values are retained; unknown phone, CGPA, employment, availability, relocation, experience, work authorization, and salary amounts intentionally remain `null`. Fill only values you have verified. Salary entries are separated by seniority, currency, and monthly/annual period.

Set `GEMINI_API_KEY` and optionally `GEMINI_MODEL` in `backend/.env` before starting Compose. Accepted medium/high-confidence Gemini answers are saved in `generatedSuggestions` and reused before another model call. Answers Gemini marks reusable may cross compatible jobs; job-specific answers are restricted to the exact job fingerprint. They never overwrite verified fields. Dates, salary, identity, and other factual answers still require verified profile data or deterministic derivation. The [API documentation](backend/API.md) contains the schema and [sample request](backend/examples/form-answers.input.json) and [sample output](backend/examples/form-answers.output.json).

Automatic submission requires both `FORM_AUTO_SUBMIT=true` and `verified.automationConsents.automaticSubmission=true`. Required legal declarations are never delegated to Gemini: add an exact normalized declaration label to `verified.automationConsents.legalDeclarations` only after you have explicitly chosen to accept it. CAPTCHA, authentication, inaccessible/closed forms, unsupported required controls, unresolved required facts, and failed validation stop with `needs_manual_action`. Once Submit has been clicked, missing confirmation evidence produces `submission_unknown`, which is never retried automatically.

## Application history and tracker synchronization

`GET /api/jobs/:applicationId` returns the stored job metadata, original LinkedIn URL, resolved application URL, selected resume, independent workflows, normalized questions/answers, every form attempt, confirmation evidence, errors, and Sheets sync state. `POST /api/jobs/:applicationId/sync` retries only tracker synchronization and never repeats Gmail or form work.

The backend can synchronize form outcomes to the existing **Pakistan Job Application Tracker** → **Applications** tab. Set `GOOGLE_SHEETS_SYNC_ENABLED=true` and place a service-account JSON file at `backend/data/playwright/google-service-account.json`, then share the spreadsheet with that service-account email. The file is ignored by Git and is available in Compose through the existing read/write authentication-state mount. n8n OAuth credentials remain encrypted inside n8n and are not copied or extracted.

The backend adds only missing tracking columns: `Application ID`, `Application URL`, `Form Status`, `Form Updated At`, `Submission Evidence`, `Form Resume`, and `Form Notes`. It matches `Application ID` first, adopts an older n8n row by `Job Link` only when necessary, and then stores the stable ID. Existing `Status`, `Notes`, and manually populated shared fields are preserved. For mixed applications, n8n continues to own email-draft updates while the backend owns the form-specific columns.

The verified profile also records positive preferences for onsite work, relocation, night/different shifts, flexible hours, willingness to learn, and negotiable salary. These deterministic answers take priority over Gemini. Salary amounts still remain tied to configured seniority, currency, and monthly/annual periods; flexibility only permits the nearest listed range when the exact amount is unavailable.

## Persistent form authentication

Google may reject sign-in when Chrome is launched by Playwright, even if `PLAYWRIGHT_BROWSER_EXECUTABLE_PATH` points to the stable Google Chrome binary. The recommended Fedora flow is therefore to complete login in a separately launched normal Chrome instance that uses a dedicated profile, then let the CLI capture that session over a loopback-only Chrome DevTools Protocol connection.

In the first terminal, from `backend`, launch Chrome with a profile used only by this application:

```bash
mkdir -p data/chrome-auth-profile
google-chrome-stable \
  --user-data-dir="$PWD/data/chrome-auth-profile" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  https://accounts.google.com/
```

On Fedora systems that install a different command, replace `google-chrome-stable` with `google-chrome` or `chromium`. Sign in manually and complete any legitimate Google security challenge. Do not use your everyday Chrome data directory.

After the account is visibly signed in, run this from a second terminal:

```bash
cd backend
FORM_AUTH_CDP_URL=http://127.0.0.1:9222 npm run auth:form
```

The application never accepts or stores your password. It attaches only to that dedicated browser, verifies a current Google session cookie, and stores browser session cookies/origin state in the mode-`0600` file configured by `FORM_AUTH_STATE_PATH`. Close the dedicated Chrome window afterward and protect both its profile directory and the state file like login sessions. Keeping the profile outside `data/playwright` also prevents the Compose bind mount from copying the full profile into the backend container. The normal form processor continues loading only the compact saved state into a fresh isolated context for every application.

The original `npm run auth:form` flow remains available for identity providers that permit a Playwright-launched interactive browser. If Google displays “Couldn’t sign you in,” the command now fails explicitly instead of incorrectly treating incidental Google cookies as a successful login.

The Compose setup bind-mounts the ignored `backend/data/playwright` directory into the backend container. Authenticate before starting Compose, or stop the backend container before refreshing the session, so the desktop CLI and container use the same state safely.

Do not set `FORM_AUTH_CDP_URL` in Compose: its loopback address belongs to the desktop session and the Docker backend only needs the saved state file. If Google Workspace uses another identity provider, set `FORM_AUTH_LOGIN_URL` to its trusted HTTPS login entry point. An expired or rejected session produces `reauthentication_required`; repeat the dedicated-profile capture command to refresh it. CAPTCHA and security challenges remain manual and are never bypassed.

## 5. Test safely without a real application

Run the backend test suite. Its Playwright tests use a temporary loopback-only mock form and never contact or submit a real job application:

```bash
cd backend
npm install
npx playwright install chromium
npm test
```

The suite covers schema migration, structured answer/attempt persistence, Sheets row adoption and duplicate prevention, mixed email/form retries, two-page navigation, text, textarea, radio, checkbox, select, date, verified resume upload, persisted authenticated sessions, expired-session detection, preference-based answers, flexible salary ranges, confirmed automatic submission, CAPTCHA blocking, legal-consent blocking, and a Submit click without confirmation evidence.

## Manual extension test checklist

- **Visible text URL:** Expand a post whose text contains `https://example.com/apply` and select its text. Open the popup. Confirm capture happens without a Capture button, the exact selection is preserved, the post permalink is shown, and the normalized URL appears once.
- **`www.` and shortened URL:** Use a post containing `www.example.com/jobs` and `https://lnkd.in/dczcArdc`. Confirm `www.` becomes `https://www.example.com/jobs`, and the popup says the `lnkd.in` URL will be resolved on Send. After sending, confirm the backend response contains `https://evahires.com/jobs/private/11` (or retains the original URL with a warning in backend logs if resolution is temporarily unavailable).
- **Clickable-label link:** Use a post whose Apply link is clickable but whose visible label contains no URL. Select text in that post. Confirm the anchor destination is included in Application links.
- **Duplicate/mixed links:** Use the same destination in visible text and in a DOM anchor, plus a LinkedIn redirect wrapper. Confirm the redirect destination is unwrapped when exposed in the DOM and each normalized destination appears only once.
- **Multiple posts:** Leave two posts visible. Select text strictly inside the second post and open the popup; confirm the second post's text, permalink, and links are captured, with no links from the first. Then select across both posts and confirm a single-post selection error is shown.
- **Expanded content:** Click “see more”, select the expanded post, and open the popup. Confirm the expanded text and its links are present.
- **No selection:** On a feed with multiple visible posts, clear the selection and open the popup; confirm it asks you to select one post. On an individual post page with one visible post, confirm it can capture without a selection.
- **No links:** Select a plain-text post with no application links. Confirm the text and permalink are captured, Application links stays empty, and Send remains available.
- **Manual send only:** Review/edit all fields and click Send. Confirm the extension sends exactly `text`, `url`, `links`, and `capturedAt` to the backend, and that opening the popup alone never sends anything.
- **Google Form:** Use only a disposable test form. Confirm its workflow becomes `completed` only after the response-confirmation page is visible. Confirm the selected resume comes from the configured read-only resume directory.
- **Blocked form:** On a disposable CAPTCHA/authentication fixture or a required unconfigured declaration, confirm the workflow becomes `needs_manual_action` and the form is not submitted.
- **Browser coverage:** Run the checklist in Firefox first, then load the unpacked extension in Chrome/Chromium and repeat the selection, clickable-link, and Send cases.

## Limits and troubleshooting
- Backend connection refused: run `docker compose up -d --build` and verify port 3000 is available on the same computer as the browser.
- Email workflow HTTP 404: publish the n8n workflow, or explicitly configure and arm its test URL.
- LinkedIn markup changes: use manual text/link entry; no private endpoints or session cookies are used.
- Form detection is rule-based. Unknown destinations use `needs_review`; image-only job ads need manual transcription.
- Only Google Forms have an automation adapter. Other form platforms remain durable `needs_manual_action` workflows until their own adapters are implemented.
- Google file-upload forms reuse the saved authenticated session. Missing or expired sessions stop as `needs_manual_action` and identify whether initial authentication or reauthentication is needed.
- Google can revoke an otherwise unexpired browser session. In that case the workflow returns `reauthentication_required`; no local cookie-expiry check can predict server-side revocation.
- CDP capture requires a desktop Chrome/Chromium instance on the same machine as the authentication CLI. It is intentionally restricted to loopback and is not a remote or container authentication mechanism.
- Playwright screenshots for failures are written under the configured form-artifacts directory. They may contain application data, so keep that directory local and private.
- An empty `API_TOKEN` is acceptable only while ports remain loopback-only. Configure a token and HTTPS before any broader exposure.
- Live Gmail/Google Sheets credentials are not exercised by tests; the Sheets API is mocked so no tracker row is changed.

Official references: https://docs.n8n.io/hosting/installation/docker/ and https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
