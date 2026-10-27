(() => {
  const CAPTURE_SCRIPT_VERSION = '0.2.2';
  const CAPTURE_MESSAGE_TYPE = 'JOB_POST_N8N_CAPTURE_0_2_2';
  if (globalThis.__jobPostN8nCaptureInstalled === CAPTURE_SCRIPT_VERSION) return;
  globalThis.__jobPostN8nCaptureInstalled = CAPTURE_SCRIPT_VERSION;

  const api = globalThis.browser || globalThis.chrome;
  const POST_SELECTOR = [
    '[data-urn^="urn:li:activity:"]',
    '[data-id^="urn:li:activity:"]',
    '[data-activity-urn^="urn:li:activity:"]',
    '.feed-shared-update-v2',
    '[data-view-name="feed-full-update"]',
    '[data-view-name="feed-update"]',
    '.occludable-update',
    '[role="article"]',
    'article'
  ].join(',');
  const TEXT_SELECTOR = [
    '.update-components-text',
    '.feed-shared-update-v2__description',
    '[data-test-id="main-feed-activity-card__commentary"]',
    '[data-view-name="feed-commentary"]'
  ].join(',');
  const PERMALINK_SELECTOR = [
    'a[href*="/feed/update/urn:li:activity:"]',
    'a[href*="/posts/"]',
    'a[href*="/pulse/"]'
  ].join(',');

  let lastSelection = null;

  function elementForNode(node) {
    return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  }

  function postRank(element) {
    if (element.matches('[data-urn^="urn:li:activity:"]')) return 50;
    if (element.matches('[data-id^="urn:li:activity:"], [data-activity-urn^="urn:li:activity:"]')) return 48;
    if (element.matches('.feed-shared-update-v2')) return 40;
    if (element.matches('[data-view-name="feed-full-update"], [data-view-name="feed-update"]')) return 35;
    if (element.matches('.occludable-update')) return 25;
    if (element.matches('[role="article"]')) return 15;
    return 10;
  }

  function findPostForElement(element) {
    const matches = [];
    for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
      if (current.matches?.(POST_SELECTOR)) matches.push(current);
    }
    return matches.sort((a, b) => postRank(b) - postRank(a))[0] || null;
  }

  function findPostForRange(range, text) {
    // A visual selection often starts and ends in different nested LinkedIn
    // wrappers. Its common ancestor is still inside the one enclosing post.
    const commonPost = findPostForElement(elementForNode(range.commonAncestorContainer));
    if (commonPost) return commonPost;

    return findUniquePostContainingText(text) || findSelectionContainer(range, text);
  }

  function findSelectionContainer(range, text) {
    const needle = text.replace(/\s+/g, ' ').trim();
    let current = elementForNode(range.commonAncestorContainer);
    let best = current;
    const maximumUsefulText = Math.max(needle.length * 3, needle.length + 1500);

    // LinkedIn regularly changes or removes wrapper class names. Walk upward
    // from the range and retain the largest reasonably scoped container rather
    // than rejecting an otherwise valid selection.
    while (current && current !== document.body && current !== document.documentElement) {
      if (current.matches?.('main, [role="main"]')) break;
      const currentText = (current.innerText || '').replace(/\s+/g, ' ').trim();
      if (currentText.includes(needle) && currentText.length <= maximumUsefulText) best = current;
      if (currentText.length > maximumUsefulText) break;
      current = current.parentElement;
    }
    return best?.isConnected ? best : null;
  }

  function rememberSelection() {
    const selection = document.getSelection();
    const text = selection?.toString().trim();
    if (!text || !selection.rangeCount) return;

    const range = selection.getRangeAt(0).cloneRange();
    lastSelection = {
      text,
      range,
      post: findPostForRange(range, text)
    };
  }

  document.addEventListener('selectionchange', rememberSelection, true);
  document.addEventListener('pointerup', rememberSelection, true);
  document.addEventListener('keyup', rememberSelection, true);

  function currentOrRememberedSelection() {
    rememberSelection();
    if (!lastSelection?.text) return null;
    if (lastSelection.post?.isConnected) return lastSelection;

    // LinkedIn can replace a post wrapper after “see more”. Re-associate only
    // when exactly one post contains the remembered text.
    const post = findUniquePostContainingText(lastSelection.text) ||
      (lastSelection.range ? findSelectionContainer(lastSelection.range, lastSelection.text) : null);
    return {...lastSelection, post};
  }

  function findUniquePostContainingText(text) {
    const needle = text.replace(/\s+/g, ' ').trim();
    if (!needle) return null;

    const matches = [...document.querySelectorAll(POST_SELECTOR)]
      .filter(post => (post.innerText || '').replace(/\s+/g, ' ').includes(needle));

    // Nested wrappers from one post form a containment chain. Neighboring
    // posts produce multiple roots and remain intentionally ambiguous.
    const roots = matches.filter(post =>
      !matches.some(other => other !== post && other.contains(post))
    );
    if (roots.length !== 1) return null;

    return matches
      .filter(post => roots[0].contains(post) || post === roots[0])
      .sort((a, b) => postRank(b) - postRank(a))[0] || roots[0];
  }

  function uniquePosts(posts) {
    return posts.filter((post, index) => {
      if (!post.isConnected || posts.indexOf(post) !== index) return false;
      const postUrn = activityUrn(post);
      return !posts.some(other =>
        other !== post && other.contains(post) && activityUrn(other) && activityUrn(other) === postUrn
      );
    });
  }

  function visiblePosts() {
    return uniquePosts([...document.querySelectorAll(POST_SELECTOR)])
      .filter(post => {
        const rect = post.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
      })
      .filter(post => post.querySelector(TEXT_SELECTOR) || (post.innerText || '').trim().length > 40);
  }

  function activityUrn(post) {
    return post?.closest('[data-urn^="urn:li:activity:"]')?.getAttribute('data-urn') ||
      post?.closest('[data-id^="urn:li:activity:"]')?.getAttribute('data-id') ||
      post?.closest('[data-activity-urn^="urn:li:activity:"]')?.getAttribute('data-activity-urn') ||
      post?.querySelector('[data-urn^="urn:li:activity:"]')?.getAttribute('data-urn') ||
      post?.querySelector('[data-id^="urn:li:activity:"]')?.getAttribute('data-id') ||
      post?.querySelector('[data-activity-urn^="urn:li:activity:"]')?.getAttribute('data-activity-urn') || null;
  }

  function primaryPostText(post) {
    if (!post) return '';
    const nodes = [...post.querySelectorAll(TEXT_SELECTOR)]
      .filter(node => findPostForElement(node) === post || post.contains(findPostForElement(node)));
    const unique = nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
    return unique.map(node => node.innerText?.trim()).filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] || '';
  }

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
      const url = new URL(candidate, location.href);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.hash = '';
      if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
      return url.href;
    } catch {
      return null;
    }
  }

  function visibleTextUrls(text) {
    return text.match(/(?:https?:\/\/|www\.)[^\s<>"']+/gi) || [];
  }

  function unwrapLinkedInRedirect(value) {
    try {
      const url = new URL(value);
      if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return value;
      if (!/(?:\/redir\/redirect|\/safety\/go)/.test(url.pathname)) return value;
      return url.searchParams.get('url') || value;
    } catch {
      return value;
    }
  }

  function isApplicationAnchor(url) {
    if (/^mailto:/i.test(url)) return true;
    try {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase() === 'lnkd.in' || !/(^|\.)linkedin\.com$/i.test(parsed.hostname);
    } catch {
      return false;
    }
  }

  function extractLinks(post, selectedText, postText, permalink) {
    const raw = [...visibleTextUrls(`${selectedText}\n${postText}`)];
    for (const anchor of post?.querySelectorAll?.('a[href]') || []) {
      const href = unwrapLinkedInRedirect(anchor.href);
      if (isApplicationAnchor(href)) raw.push(href);
      // LinkedIn sometimes renders the destination only as the anchor label.
      raw.push(...visibleTextUrls(anchor.innerText || ''));
    }

    const permalinkKey = normalizeUrl(permalink || '');
    const byKey = new Map();
    for (const value of raw) {
      const normalized = normalizeUrl(value);
      if (!normalized || normalized === permalinkKey) continue;
      const key = normalized.replace(/\/$/, '');
      if (!byKey.has(key)) byKey.set(key, normalized);
    }
    return [...byKey.values()];
  }

  function postPermalink(post) {
    if (!/(^|\.)linkedin\.com$/i.test(location.hostname)) return normalizeUrl(location.href);
    const fromAnchor = normalizeUrl(post?.querySelector?.(PERMALINK_SELECTOR)?.href || '');
    if (fromAnchor) {
      const url = new URL(fromAnchor);
      url.search = '';
      url.hash = '';
      return url.href;
    }
    const urn = post ? activityUrn(post) : null;
    return urn ? `https://www.linkedin.com/feed/update/${urn}/` : normalizeUrl(location.href);
  }

  function capturePost() {
    const remembered = currentOrRememberedSelection();
    let post = remembered?.post || null;

    if (!post && !remembered?.text) {
      const candidates = visiblePosts();
      if (candidates.length !== 1) {
        throw new Error(candidates.length
          ? 'Several posts are visible. Select text inside one post, then reopen the popup.'
          : 'No LinkedIn post was detected. Open a post or select its text, then reopen the popup.');
      }
      post = candidates[0];
    }

    const selectedText = remembered?.text || '';
    const postText = primaryPostText(post);
    const text = selectedText || postText;
    if (!text) throw new Error('The post text could not be read. Expand “see more”, select the post text, and reopen the popup.');

    const url = postPermalink(post);
    return {text, url, links: extractLinks(post, selectedText, postText, url)};
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== CAPTURE_MESSAGE_TYPE) return undefined;
    try {
      sendResponse({ok: true, capture: capturePost()});
    } catch (error) {
      sendResponse({ok: false, error: error.message});
    }
    // Callback responses work in Firefox and in Chrome versions that do not
    // yet support a Promise returned from an onMessage listener.
    return true;
  });
})();
