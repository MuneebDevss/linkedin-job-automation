# LinkedIn → n8n: milestone 1

This starter captures ONE post after your click, previews it, POSTs to local n8n, and shows tentative role/email/form extraction. No login credentials, paid AI, email sending or form submissions. Batch Saved Posts processing comes later. Reading LinkedIn pages may still be subject to its terms; manual triggering does not remove that constraint.

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

Chrome/Chromium: open chrome://extensions → enable Developer mode → Load unpacked → choose the extension folder. Remove browser_specific_settings from manifest.json if your Chromium version objects to that Firefox metadata.

## 4. Capture a real post
Open a LinkedIn post and expand “see more”. If the saved-post list is ambiguous, select the text of one post first. Open the extension and click Capture post. Verify/edit the text, post URL, and links. When selecting text without a recognizable post container, links may be absent: paste any application link manually. A Saved Posts page URL is not a post permalink; replace it if needed.

Click Send to n8n. The popup displays the workflow's JSON response, including roleCandidate, emails, formCandidates and route. The execution is also visible in n8n. If popup closes, capture again; only the webhook URL is persisted.

## 5. Test without LinkedIn first
Paste the following into the extension text box, add any sample URL, arm the n8n test listener, then send:

Hiring: Junior Node.js Developer
Apply: hiring@example.com
Application: https://docs.google.com/forms/d/e/example/viewform

Expected: roleCandidate contains the first line, emails contains hiring@example.com, formCandidates contains the form URL, route is email_and_form. This URL is sample data, not a working form.

## Limits and troubleshooting
- Connection refused: n8n must run on the SAME computer as this browser. This ChatGPT workspace is separate from your laptop.
- HTTP 404: arm the test listener or publish the workflow and switch to its Production URL.
- LinkedIn markup changes: use manual text/link entry; no private endpoints or session cookies are used.
- Form candidates are URL-pattern guesses. Shortened lnkd.in links are kept under otherLinks and are not resolved. Image-only job ads need manual transcription in this version.
- A roleCandidate is a matching line, not verified semantic extraction. Several emails or roles require review.
- No duplicate tracking, resume selection, AI extraction, authentication for public hosting, email sending or form filling yet.
- Browser installation and live n8n/LinkedIn integration must be verified on your machine. Local JavaScript/parser checks do not establish browser compatibility or successful n8n import.

Official references: https://docs.n8n.io/hosting/installation/docker/ and https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
