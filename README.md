# LinkedIn job automation

The Firefox/Chrome extension captures one selected job post and sends it to a local NestJS backend. The backend normalizes destinations, classifies the application method, stores durable workflow state in SQLite, forwards email applications to the existing n8n webhook, and queues form applications for a later automation patch. It never submits a form automatically.

## 1. Start the backend and n8n
Install Docker Engine and the Docker Compose plugin (if missing). In this extracted folder run:

```bash
docker compose up -d --build
```

The backend is available at `http://127.0.0.1:3000`, and n8n remains at `http://127.0.0.1:5678`. Both ports are published only on loopback. The `backend_data` and `n8n_data` volumes are durable; do not delete them unless you intend to remove their data.

To require a shared local token, set `BACKEND_API_TOKEN` before starting Compose and enter the same value in the extension. Direct-development variables are documented in [backend/.env.example](backend/.env.example), and the complete API contract is in [backend/API.md](backend/API.md).

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

Click Send. For email applications, the backend invokes n8n and returns the email workflow status. For form applications, it returns a durable form job ID with `pending` status. Combined applications contain independent email and form statuses, so one branch cannot prevent the other from being recorded or executed. Repeated captures are deduplicated independently per branch.

## Profile-based form answers

The backend now exposes `POST /api/forms/answers` for answer generation only. It does not fill or submit forms. The engine matches common question variants, selects a resume from the existing catalog, and applies this strict order: verified profile → approved reusable answer → deterministic derivation → Gemini → unresolved.

Review [the local profile](backend/data/profile.json) before use. Existing supplied values are retained; unknown phone, CGPA, employment, availability, relocation, experience, work authorization, and salary amounts intentionally remain `null`. Fill only values you have verified. Salary entries are separated by seniority, currency, and monthly/annual period.

Set `GEMINI_API_KEY` and optionally `GEMINI_MODEL` in the environment before starting Compose. Gemini suggestions are saved separately as unapproved suggestions and are never allowed to overwrite verified fields. The [API documentation](backend/API.md) contains the schema and [sample request](backend/examples/form-answers.input.json) and [sample output](backend/examples/form-answers.output.json).

## 5. Test without LinkedIn first
Paste the following into the extension text box, add any sample URL, ensure the backend and published n8n workflow are running, then send:

Hiring: Junior Node.js Developer
Apply: hiring@example.com
Application: https://docs.google.com/forms/d/e/example/viewform

Expected: `method` is `email_and_form`; the email workflow reports the n8n result, while the form workflow returns a durable ID with `pending` status. This URL is sample data, not a working form.

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
- **Browser coverage:** Run the checklist in Firefox first, then load the unpacked extension in Chrome/Chromium and repeat the selection, clickable-link, and Send cases.

## Limits and troubleshooting
- Backend connection refused: run `docker compose up -d --build` and verify port 3000 is available on the same computer as the browser.
- Email workflow HTTP 404: publish the n8n workflow, or explicitly configure and arm its test URL.
- LinkedIn markup changes: use manual text/link entry; no private endpoints or session cookies are used.
- Form detection is rule-based. Unknown destinations use `needs_review`; image-only job ads need manual transcription.
- Form jobs intentionally stay `pending`; [FormProcessor](backend/src/forms/form-processor.interface.ts) is a placeholder for later patches.
- An empty `API_TOKEN` is acceptable only while ports remain loopback-only. Configure a token and HTTPS before any broader exposure.
- Browser installation and live Gmail/Google Sheets credentials must be verified locally. Automated backend tests do not validate third-party credentials.

Official references: https://docs.n8n.io/hosting/installation/docker/ and https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
