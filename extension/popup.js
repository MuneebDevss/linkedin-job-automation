const api = globalThis.browser || globalThis.chrome;
const CAPTURE_MESSAGE_TYPE = 'JOB_POST_N8N_CAPTURE_0_2_2';
const $ = id => document.getElementById(id);
const show = message => { $('result').textContent = message; };

function trimUrl(value) {
  return value.trim().replace(/^[<(\[{"']+/, '').replace(/[>\])}"',;:.!?]+$/, '');
}

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

function isShortLinkedInUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase() === 'lnkd.in';
  } catch {
    return false;
  }
}

async function activePageTab() {
  const [tab] = await api.tabs.query({active: true, currentWindow: true});
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error('Open a regular web page, select the job-post text, and reopen this popup.');
  }
  return tab;
}

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
      signal: AbortSignal.timeout(20000)
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
