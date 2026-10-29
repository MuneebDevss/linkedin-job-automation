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

  /**
   * **Summary:** Converts a selected DOM node into the element that can be inspected for its enclosing job post.
   * **Inputs:** `node` is a selection boundary or other DOM node.
   * **Returns:** The node itself when it is an element, its parent element otherwise, or no element when unavailable.
   */
  function elementForNode(node) {
    return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  }

  /**
   * **Summary:** Ranks LinkedIn post containers by how specifically they identify a real feed activity.
   * **Inputs:** `element` is a candidate post container.
   * **Returns:** A numeric specificity score used to choose the best container.
   */
  function postRank(element) {
    if (element.matches('[data-urn^="urn:li:activity:"]')) return 50;
    if (element.matches('[data-id^="urn:li:activity:"], [data-activity-urn^="urn:li:activity:"]')) return 48;
    if (element.matches('.feed-shared-update-v2')) return 40;
    if (element.matches('[data-view-name="feed-full-update"], [data-view-name="feed-update"]')) return 35;
    if (element.matches('.occludable-update')) return 25;
    if (element.matches('[role="article"]')) return 15;
    return 10;
  }

  /**
   * **Summary:** Finds the most specific LinkedIn post that encloses a selected page element.
   * **Inputs:** `element` is an element within or near a job post.
   * **Returns:** The best enclosing post container, or `null` when none is found.
   */
  function findPostForElement(element) {
    const matches = [];
    for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
      if (current.matches?.(POST_SELECTOR)) matches.push(current);
    }
    return matches.sort((a, b) => postRank(b) - postRank(a))[0] || null;
  }

  /**
   * **Summary:** Associates a text selection with its enclosing post, using text and selection scope when LinkedIn wrappers are ambiguous.
   * **Inputs:** `range` is the browser selection range; `text` is its selected text.
   * **Returns:** The associated post or scoped selection container, or `null` when association is unsafe.
   */
  function findPostForRange(range, text) {
    // A visual selection often starts and ends in different nested LinkedIn
    // wrappers. Its common ancestor is still inside the one enclosing post.
    const commonPost = findPostForElement(elementForNode(range.commonAncestorContainer));
    if (commonPost) return commonPost;

    return findUniquePostContainingText(text) || findSelectionContainer(range, text);
  }

  /**
   * **Summary:** Finds a reasonably scoped container for selected job text when no recognized LinkedIn post wrapper is available.
   * **Inputs:** `range` identifies the selection location; `text` is the selected content.
   * **Returns:** The largest useful connected container, or `null` when none remains available.
   */
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

  /**
   * **Summary:** Remembers the user's current text selection and its associated post so the popup can capture it after focus changes.
   * **Inputs:** No parameters; the function reads the active document selection.
   * **Returns:** No value; the latest usable selection is stored for later capture.
   */
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

  /**
   * **Summary:** Returns the latest usable selection and repairs its post association when LinkedIn has replaced page wrappers.
   * **Inputs:** No parameters; current and remembered document selections are considered.
   * **Returns:** The remembered selection with its best current post association, or `null` when no text was selected.
   */
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

  /**
   * **Summary:** Finds one unambiguous LinkedIn post whose visible content contains the selected text.
   * **Inputs:** `text` is the remembered selection to locate.
   * **Returns:** The most specific matching post, or `null` when zero or multiple posts match.
   */
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

  /**
   * **Summary:** Removes disconnected, duplicate, and redundant nested post containers from a candidate list.
   * **Inputs:** `posts` contains candidate LinkedIn post elements.
   * **Returns:** The unique connected post containers.
   */
  function uniquePosts(posts) {
    return posts.filter((post, index) => {
      if (!post.isConnected || posts.indexOf(post) !== index) return false;
      const postUrn = activityUrn(post);
      return !posts.some(other =>
        other !== post && other.contains(post) && activityUrn(other) && activityUrn(other) === postUrn
      );
    });
  }

  /**
   * **Summary:** Lists substantial LinkedIn posts currently visible in the viewport for unambiguous capture without a selection.
   * **Inputs:** No parameters; the active page DOM and viewport are inspected.
   * **Returns:** The unique visible post containers containing meaningful text.
   */
  function visiblePosts() {
    return uniquePosts([...document.querySelectorAll(POST_SELECTOR)])
      .filter(post => {
        const rect = post.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
      })
      .filter(post => post.querySelector(TEXT_SELECTOR) || (post.innerText || '').trim().length > 40);
  }

  /**
   * **Summary:** Retrieves the LinkedIn activity identity associated with a post container.
   * **Inputs:** `post` is a candidate LinkedIn post element.
   * **Returns:** The activity URN, or `null` when the page does not expose one.
   */
  function activityUrn(post) {
    return post?.closest('[data-urn^="urn:li:activity:"]')?.getAttribute('data-urn') ||
      post?.closest('[data-id^="urn:li:activity:"]')?.getAttribute('data-id') ||
      post?.closest('[data-activity-urn^="urn:li:activity:"]')?.getAttribute('data-activity-urn') ||
      post?.querySelector('[data-urn^="urn:li:activity:"]')?.getAttribute('data-urn') ||
      post?.querySelector('[data-id^="urn:li:activity:"]')?.getAttribute('data-id') ||
      post?.querySelector('[data-activity-urn^="urn:li:activity:"]')?.getAttribute('data-activity-urn') || null;
  }

  /**
   * **Summary:** Extracts the primary commentary text from a post while avoiding duplicate nested text wrappers.
   * **Inputs:** `post` is the selected LinkedIn post container.
   * **Returns:** The most complete visible post text, or an empty string when unavailable.
   */
  function primaryPostText(post) {
    if (!post) return '';
    const nodes = [...post.querySelectorAll(TEXT_SELECTOR)]
      .filter(node => findPostForElement(node) === post || post.contains(findPostForElement(node)));
    const unique = nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
    return unique.map(node => node.innerText?.trim()).filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] || '';
  }

  /**
   * **Summary:** Removes surrounding punctuation introduced when a URL is copied from visible post text.
   * **Inputs:** `value` is the raw URL-like text.
   * **Returns:** The trimmed candidate URL.
   */
  function trimUrl(value) {
    return value.trim().replace(/^[<(\[{"']+/, '').replace(/[>\])}"',;:.!?]+$/, '');
  }

  /**
   * **Summary:** Converts a captured web or email link into a consistent URL suitable for backend processing.
   * **Inputs:** `value` is the raw link found in the post or page.
   * **Returns:** The normalized URL, or `null` when the value is unsupported or invalid.
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
      const url = new URL(candidate, location.href);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.hash = '';
      if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
      return url.href;
    } catch {
      return null;
    }
  }

  /**
   * **Summary:** Finds URL-like text that is visibly embedded in a selected job post.
   * **Inputs:** `text` is selected or extracted post content.
   * **Returns:** The raw web links present in the text.
   */
  function visibleTextUrls(text) {
    return text.match(/(?:https?:\/\/|www\.)[^\s<>"']+/gi) || [];
  }

  /**
   * **Summary:** Extracts the destination advertised by a LinkedIn redirect while leaving unrelated URLs unchanged.
   * **Inputs:** `value` is a captured anchor URL.
   * **Returns:** The embedded destination when present, otherwise the original value.
   */
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

  /**
   * **Summary:** Determines whether a captured anchor may lead to an application destination rather than LinkedIn navigation.
   * **Inputs:** `url` is the normalized or unwrapped anchor destination.
   * **Returns:** `true` for email, short, or external destinations, otherwise `false`.
   */
  function isApplicationAnchor(url) {
    if (/^mailto:/i.test(url)) return true;
    try {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase() === 'lnkd.in' || !/(^|\.)linkedin\.com$/i.test(parsed.hostname);
    } catch {
      return false;
    }
  }

  /**
   * **Summary:** Collects and deduplicates application links from selected text, post text, and relevant post anchors.
   * **Inputs:** `post` is the selected container; `selectedText` and `postText` are captured content; `permalink` identifies the post itself.
   * **Returns:** The normalized application destinations excluding the post permalink.
   */
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

  /**
   * **Summary:** Determines the most stable permalink for the captured LinkedIn post.
   * **Inputs:** `post` is the selected post container when available.
   * **Returns:** The post permalink, an activity-based URL, or the normalized current page URL.
   */
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

  /**
   * **Summary:** Captures one unambiguous job post with its text, stable source URL, and discovered application links.
   * **Inputs:** No parameters; the function uses the current or remembered page selection and visible posts.
   * **Returns:** The captured post payload; ambiguous or unreadable pages cause an actionable error.
   */
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
