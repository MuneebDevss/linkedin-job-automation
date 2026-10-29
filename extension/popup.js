const api = globalThis.browser || globalThis.chrome;
const CAPTURE_MESSAGE_TYPE = 'JOB_POST_N8N_CAPTURE_0_2_2';
/**
 * **Summary:** Locates a popup control by its stable element identifier.
 * **Inputs:** `id` is the popup element ID.
 * **Returns:** The matching DOM element, or `null` when it is absent.
 */
const $ = id => document.getElementById(id);
/**
 * **Summary:** Displays capture, processing, or error feedback in the popup result area.
 * **Inputs:** `message` is the user-facing status text to display.
 * **Returns:** No value; the result area is updated.
 */
const show = message => { $('result').textContent = message; };

/**
 * **Summary:** Removes punctuation that may surround a URL copied from visible job-post text.
 * **Inputs:** `value` is the raw URL-like text.
 * **Returns:** The trimmed candidate URL.
 */
function trimUrl(value) {
  return value.trim().replace(/^[<(\[{"']+/, '').replace(/[>\])}"',;:.!?]+$/, '');
}

/**
 * **Summary:** Converts a captured web or email link into a consistent URL for review and backend submission.
 * **Inputs:** `value` is the raw captured link.
 * **Returns:** The normalized URL, or `null` when invalid or unsupported.
 */
function normalizeUrl(value) {
  let candidate = trimUrl(value);
  if (!candidate) return null;
  if (/^www\./i.test(candidate)) candidate = `https://${candidate}`;
  if (/^mailto:/i.test(candidate)) {
    const [address, query = ''] = candidate.slice(7).split('?');
    return `mailto:${address.toLowerCase()}${query ? `?${query}` : ''}`;
  }
  try {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * **Summary:** Normalizes and deduplicates the application links shown and submitted by the popup.
 * **Inputs:** `values` contains raw links from capture or manual editing.
 * **Returns:** The unique normalized links.
 */
function normalizeLinks(values) {
  const links = new Map();
  for (const value of values) {
    const normalized = normalizeUrl(value);
    if (!normalized) continue;
    const key = normalized.replace(/\/$/, '');
    if (!links.has(key)) links.set(key, normalized);
  }
  return [...links.values()];
}

/**
 * **Summary:** Identifies shortened LinkedIn destinations that the backend will resolve under its network-safety policy.
 * **Inputs:** `value` is a normalized link.
 * **Returns:** `true` when the link uses `lnkd.in`, otherwise `false`.
 */
function isShortLinkedInUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase() === 'lnkd.in';
  } catch {
    return false;
  }
}

/**
 * **Summary:** Retrieves the active regular web-page tab that can supply a job-post capture.
 * **Inputs:** No parameters; the current browser window is queried.
 * **Returns:** The active tab, or an actionable error when capture is unavailable there.
 */
async function activePageTab() {
  const [tab] = await api.tabs.query({active: true, currentWindow: true});
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error('Open a regular web page, select the job-post text, and reopen this popup.');
  }
  return tab;
}

/**
 * **Summary:** Requests a capture from the active tab and installs the current capture script once when an older tab lacks it.
 * **Inputs:** `tab` is the active web-page tab to capture.
 * **Returns:** The content script's capture response.
 */
async function requestCapture(tab) {
  try {
    const result = await api.tabs.sendMessage(tab.id, {type: CAPTURE_MESSAGE_TYPE});
    if (!result) throw new Error('Current capture script is not installed in this tab.');
    return result;
  } catch {
    // Tabs already open when the extension was installed need one injection.
    await api.scripting.executeScript({target: {tabId: tab.id}, files: ['content.js']});
    return api.tabs.sendMessage(tab.id, {type: CAPTURE_MESSAGE_TYPE});
  }
}

/**
 * **Summary:** Automatically captures the active job post when the popup opens and prepares the payload for user review.
 * **Inputs:** No parameters; the active page and stored popup controls are used.
 * **Returns:** A promise that resolves after the preview and status are updated.
 */
async function captureOnOpen() {
  $('send').disabled = true;
  try {
    const tab = await activePageTab();
    const result = await requestCapture(tab);
    if (!result?.ok) throw new Error(result?.error || 'The selected LinkedIn post could not be captured.');

    const links = normalizeLinks(result.capture.links || []);
    $('text').value = result.capture.text;
    $('postUrl').value = result.capture.url || tab.url;
    $('links').value = links.join('\n');
    $('send').disabled = false;

    const unresolved = links.filter(isShortLinkedInUrl).length;
    show(unresolved
      ? `Captured. ${unresolved} shortened link(s) will be resolved safely by the backend when you click Send.`
      : 'Captured automatically. Review the text, URL, and links before sending.');
  } catch (error) {
    show(error.message);
    // Manual paste/edit remains available when LinkedIn's DOM cannot be read.
    $('send').disabled = false;
  }
}

$('send').onclick = async () => {
  $('send').disabled = true;
  try {
    const url = new URL($('url').value);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/api\/jobs\/process\/?$/.test(url.pathname)) {
      throw new Error('Use the local backend endpoint, for example http://127.0.0.1:3000/api/jobs/process.');
    }
    const text = $('text').value.trim();
    if (!text) throw new Error('No post text is available. Select one LinkedIn post and reopen the popup, or paste text into the preview.');

    const links = normalizeLinks($('links').value.split('\n'));
    $('links').value = links.join('\n');
    const apiToken = $('token').value.trim();
    await api.storage.local.set({backendUrl: url.href, backendApiToken: apiToken});
    const response = await fetch(url.href, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiToken ? {'X-API-Key': apiToken} : {})
      },
      body: JSON.stringify({
        text,
        url: $('postUrl').value.trim(),
        links,
        capturedAt: new Date().toISOString()
      }),
      // Form applications may inspect and fill several pages before the API
      // can return a confirmed terminal status.
      signal: AbortSignal.timeout(180000)
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      throw new Error(errorBody?.error?.message || `Backend returned HTTP ${response.status}.`);
    }
    show(JSON.stringify(await response.json(), null, 2));
  } catch (error) {
    show(`${error.message}\nIf connection failed: start the backend and n8n services.`);
  } finally {
    $('send').disabled = false;
  }
};

api.storage.local.get(['backendUrl', 'backendApiToken'])
  .then(settings => {
    if (settings.backendUrl) $('url').value = settings.backendUrl;
    if (settings.backendApiToken) $('token').value = settings.backendApiToken;
  })
  .catch(() => {})
  .finally(captureOnOpen);
