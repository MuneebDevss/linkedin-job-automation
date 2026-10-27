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

function resolverUrl(webhookValue) {
  const url = new URL(webhookValue);
  url.pathname = url.pathname.replace(/\/linkedin-job\/?$/, '/resolve-url');
  url.search = '';
  url.hash = '';
  return url.href;
}

function isSafeResolvedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return host !== 'localhost' && host !== '0.0.0.0' && host !== '::1' &&
      !/^127\./.test(host) && !/^10\./.test(host) && !/^192\.168\./.test(host) &&
      !/^169\.254\./.test(host) && !/^172\.(1[6-9]|2\d|3[01])\./.test(host);
  } catch {
    return false;
  }
}

async function resolveShortLink(original, webhookValue) {
  // Resolution stays on the configured local backend. The extension never
  // follows an untrusted redirect itself and keeps the short URL on failure.
  let timeout;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(resolverUrl(webhookValue), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: original}),
      signal: controller.signal
    });
    if (!response.ok) return original;
    const body = await response.json();
    const resolved = normalizeUrl(body.resolvedUrl || body.url || '');
    return resolved && isSafeResolvedUrl(resolved) ? resolved : original;
  } catch {
    return original;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveShortLinks(links, webhookValue) {
  const resolved = await Promise.all(links.map(link =>
    isShortLinkedInUrl(link) ? resolveShortLink(link, webhookValue) : link
  ));
  return normalizeLinks(resolved);
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

    const links = await resolveShortLinks(normalizeLinks(result.capture.links || []), $('url').value);
    $('text').value = result.capture.text;
    $('postUrl').value = result.capture.url || tab.url;
    $('links').value = links.join('\n');
    $('send').disabled = false;

    const unresolved = links.filter(isShortLinkedInUrl).length;
    show(unresolved
      ? `Captured. ${unresolved} shortened link(s) could not be resolved and were kept unchanged. Review before sending.`
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
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '5678' || !/^\/webhook(?:-test)?\/linkedin-job\/?$/.test(url.pathname)) {
      throw new Error('This starter supports only the local n8n linkedin-job webhook on port 5678.');
    }
    const text = $('text').value.trim();
    if (!text) throw new Error('No post text is available. Select one LinkedIn post and reopen the popup, or paste text into the preview.');

    const links = normalizeLinks($('links').value.split('\n'));
    $('links').value = links.join('\n');
    await api.storage.local.set({webhookUrl: url.href});
    const response = await fetch(url.href, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        text,
        url: $('postUrl').value.trim(),
        links,
        capturedAt: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`n8n returned HTTP ${response.status}. For a test URL, click Listen for test event first.`);
    show(JSON.stringify(await response.json(), null, 2));
  } catch (error) {
    show(`${error.message}\nIf connection failed: start n8n and check its webhook listener.`);
  } finally {
    $('send').disabled = false;
  }
};

api.storage.local.get('webhookUrl')
  .then(settings => {
    if (settings.webhookUrl) $('url').value = settings.webhookUrl;
  })
  .catch(() => {})
  .finally(captureOnOpen);
