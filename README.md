# LinkedIn → n8n: milestone 1

This starter automatically captures ONE selected post when its popup opens, previews it, POSTs to local n8n only after you click Send, and shows tentative role/email/form extraction. No LinkedIn login credentials, paid AI, automatic sending or form submissions are introduced by the extension. Batch Saved Posts processing comes later. Reading LinkedIn pages may still be subject to its terms; opening the popup manually does not remove that constraint.

## 1. Start n8n on your computer
Install Docker Engine and the Docker Compose plugin (if missing). In this extracted folder run:

```bash
docker compose up -d
```

Open http://localhost:5678 and create your local owner account. The persistent Docker volume keeps your n8n data. Do not delete it. This setup binds only to your computer. Do not expose it publicly without authentication and HTTPS. The stable image tag follows releases; record/pin the tested image version after your first successful run.

## 2. Import the workflow
In n8n create a workflow, use its menu → Import from File → choose workflow.json. Save it. Select the Receive post node and click Listen for test event (or Execute workflow). Use the Test URL shown by the node; it should be http://localhost:5678/webhook-test/linkedin-job. The test listener generally needs re-arming after each request.

For ongoing use publish/activate the workflow and use its Production URL: http://localhost:5678/webhook/linkedin-job. The extension accepts localhost or 127.0.0.1 on port 5678 only. If the UI wording differs, use the equivalent import/listen/publish controls.

## 3. Load the extension
Firefox: open about:debugging#/runtime/this-firefox → Load Temporary Add-on → choose extension/manifest.json. Temporary add-ons disappear on browser restart; reload when needed. Signing/persistent distribution is a later step.

After updating or reloading the extension, refresh any LinkedIn tabs that were already open before testing selection capture. This ensures those tabs use the latest content script.

Chrome/Chromium: open chrome://extensions → enable Developer mode → Load unpacked → choose the extension folder. Remove browser_specific_settings from manifest.json if your Chromium version objects to that Firefox metadata.

## 4. Capture a real post
Open LinkedIn and expand “see more”, then select the desired job-post text before opening the extension. The popup always accepts non-empty selected text, even when LinkedIn has changed its wrapper markup or the post has no links. When a post container is recognizable, it enriches the selection with the post permalink and scans both visible text and DOM anchors for `https://`, `http://`, `www.`, `mailto:`, and `lnkd.in` links. Otherwise it safely falls back to the current page URL and URLs visible in the selection. The same selection fallback works on other regular HTTP/HTTPS tabs. Verify/edit all fields before sending. On an individual LinkedIn post page, capture can also proceed without a selection when exactly one visible post is detected.

For shortened URLs, the popup first tries a local endpoint derived from the configured webhook URL: `/webhook-test/resolve-url` or `/webhook/resolve-url`. That optional endpoint should accept `{ "url": "https://lnkd.in/..." }` and return `{ "resolvedUrl": "https://..." }`. It must allow only `lnkd.in` inputs and block redirects to local/private addresses. If the endpoint is missing, times out, or returns an unsafe URL, the original short URL remains in the editable preview.

Click Send to n8n. The popup displays the workflow's JSON response, including roleCandidate, emails, formCandidates and route. The execution is also visible in n8n. If popup closes, capture again; only the webhook URL is persisted.

## 5. Test without LinkedIn first
Paste the following into the extension text box, add any sample URL, arm the n8n test listener, then send:

Hiring: Junior Node.js Developer
Apply: hiring@example.com
Application: https://docs.google.com/forms/d/e/example/viewform

Expected: roleCandidate contains the first line, emails contains hiring@example.com, formCandidates contains the form URL, route is email_and_form. This URL is sample data, not a working form.

## Manual extension test checklist

- **Visible text URL:** Expand a post whose text contains `https://example.com/apply` and select its text. Open the popup. Confirm capture happens without a Capture button, the exact selection is preserved, the post permalink is shown, and the normalized URL appears once.
- **`www.` and shortened URL:** Use a post containing `www.example.com/jobs` and `https://lnkd.in/dczcArdc`. Confirm `www.` becomes `https://www.example.com/jobs`, and the `lnkd.in` URL is either safely resolved by the optional local resolver or retained unchanged with a useful status message.
- **Clickable-label link:** Use a post whose Apply link is clickable but whose visible label contains no URL. Select text in that post. Confirm the anchor destination is included in Application links.
- **Duplicate/mixed links:** Use the same destination in visible text and in a DOM anchor, plus a LinkedIn redirect wrapper. Confirm the redirect destination is unwrapped when exposed in the DOM and each normalized destination appears only once.
- **Multiple posts:** Leave two posts visible. Select text strictly inside the second post and open the popup; confirm the second post's text, permalink, and links are captured, with no links from the first. Then select across both posts and confirm a single-post selection error is shown.
- **Expanded content:** Click “see more”, select the expanded post, and open the popup. Confirm the expanded text and its links are present.
- **No selection:** On a feed with multiple visible posts, clear the selection and open the popup; confirm it asks you to select one post. On an individual post page with one visible post, confirm it can capture without a selection.
- **No links:** Select a plain-text post with no application links. Confirm the text and permalink are captured, Application links stays empty, and Send remains available.
- **Manual send only:** Review/edit all fields, arm the n8n test webhook, and click Send. Confirm the request still contains exactly `text`, `url`, `links`, and `capturedAt`, and that opening the popup alone never sends the webhook.
- **Browser coverage:** Run the checklist in Firefox first, then load the unpacked extension in Chrome/Chromium and repeat the selection, clickable-link, and Send cases.

## Limits and troubleshooting
- Connection refused: n8n must run on the SAME computer as this browser. This ChatGPT workspace is separate from your laptop.
- HTTP 404: arm the test listener or publish the workflow and switch to its Production URL.
- LinkedIn markup changes: use manual text/link entry; no private endpoints or session cookies are used.
- Form candidates are URL-pattern guesses. Unresolved `lnkd.in` links remain under `otherLinks`; configure the optional local resolver endpoint above if resolved destinations are needed. Image-only job ads need manual transcription in this version.
- A roleCandidate is a matching line, not verified semantic extraction. Several emails or roles require review.
- No duplicate tracking, resume selection, AI extraction, authentication for public hosting, email sending or form filling yet.
- Browser installation and live n8n/LinkedIn integration must be verified on your machine. Local JavaScript/parser checks do not establish browser compatibility or successful n8n import.

Official references: https://docs.n8n.io/hosting/installation/docker/ and https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
