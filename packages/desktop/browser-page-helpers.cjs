// Page-side code of the built-in browser's Agent commands that look for things on a page (locate, interactive, wait,
// find, scroll). Each piece is a real function sent to the page as its source text (`inPage`), never code written inside
// a template literal: a template literal silently drops the backslash of `\s` or `\d`, which once turned a whitespace
// clean-up into "remove every letter s" and made labels read from a screenshot never match.
//
// Open shadow roots are searched like the document itself: many web apps (Teams, YouTube, Salesforce) build their
// controls inside them, and a search that stops at the document cannot see those controls at all.

/** Interactive elements in document order; `index` addresses the same list for click/type without a CSS selector. */
const INTERACTIVE_QUERY = 'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="combobox"],[role="textbox"],[role="treeitem"],[role="listitem"],[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]';

/** Shared helpers, built once per command inside the page. */
function pageHelpers(interactiveQuery) {
  const roots = () => {
    const found = [document];
    for (let i = 0; i < found.length; i++) {
      const walker = document.createTreeWalker(found[i], NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.shadowRoot) found.push(node.shadowRoot);
    }
    return found;
  };
  const badSelector = (selector, error) => {
    const foreign = /:has-text\(|:text\(|:visible\b|>>|^xpath=|^text=|^\/\//.test(selector);
    return `${JSON.stringify(selector)} is not a valid CSS selector${foreign ? ' (Playwright or XPath syntax is not supported here; use label with the words shown on the element)' : ''}: ${error && error.message ? error.message : error}`;
  };
  const all = (selector) => {
    const out = [];
    for (const root of roots()) {
      let list;
      try { list = root.querySelectorAll(selector); } catch (error) { throw new Error(badSelector(selector, error)); }
      for (let i = 0; i < list.length; i++) out.push(list[i]);
    }
    return out;
  };
  const query = (selector) => {
    for (const root of roots()) {
      let found;
      try { found = root.querySelector(selector); } catch (error) { throw new Error(badSelector(selector, error)); }
      if (found) return found;
    }
    return null;
  };
  /** The innermost element at a point, inside open shadow roots too. */
  const fromPoint = (x, y) => {
    let element = document.elementFromPoint(x, y);
    while (element && element.shadowRoot) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    return element;
  };
  const parentOf = (element) => element.parentElement || (element.getRootNode && element.getRootNode() !== document ? element.getRootNode().host : null) || null;
  const contains = (outer, inner) => {
    for (let node = inner; node; node = parentOf(node)) if (node === outer) return true;
    return false;
  };
  const activeElement = () => {
    let element = document.activeElement;
    while (element && element.shadowRoot && element.shadowRoot.activeElement) element = element.shadowRoot.activeElement;
    return element;
  };
  const shown = (element) => {
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const center = (element) => {
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  };
  /** Whether the element's centre is on screen: inside the viewport and not cut off by a list or panel around it. */
  const inView = (element) => {
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    for (let node = parentOf(element); node && node !== document.documentElement && node !== document.body; node = parentOf(node)) {
      if (node.nodeType !== 1) continue;
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = node.getBoundingClientRect();
      if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) return false;
    }
    return true;
  };
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  // Words copied from a screenshot often end in an ellipsis where the page cut them, and lose punctuation the model
  // could not read; both forms are compared.
  const norm = (value) => clean(value).normalize('NFKC').toLowerCase().replace(/(?:…|\.{3,})$/u, '').trim();
  const compact = (value) => norm(value).replace(/[^\p{L}\p{N}]+/gu, '');
  const nameOf = (element) => clean(element.getAttribute('aria-label') || (element.labels && element.labels[0] && element.labels[0].innerText) || element.innerText || (element.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(element.type) ? element.value : '') || element.getAttribute('placeholder') || element.getAttribute('title') || element.getAttribute('alt') || (element.querySelector && element.querySelector('img[alt]') ? element.querySelector('img[alt]').alt : '') || element.getAttribute('name') || '');
  const describe = (element) => ({ tag: element.tagName.toLowerCase(), id: element.id || undefined, text: nameOf(element).slice(0, 80) || undefined });
  /** 5 exact, 4 same letters and digits, 3 starts with, 2 contains, 1 contains the letters and digits, 0 no match. */
  const score = (name, want) => {
    const n = norm(name), w = norm(want);
    if (!n || !w) return 0;
    if (n === w) return 5;
    const nc = compact(name), wc = compact(want);
    if (wc && nc === wc) return 4;
    if (n.startsWith(w) || (wc.length >= 3 && nc.startsWith(wc))) return 3;
    if (n.includes(w)) return 2;
    if (wc.length >= 3 && nc.includes(wc)) return 1;
    return 0;
  };
  const owner = (element) => element.closest('a,button,label,summary,[role],[onclick],[tabindex]') || element;
  /** Every visible text node with the element that owns it (the nearest control around it, or its parent). */
  const textNodes = function* () {
    for (const root of roots()) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = clean(node.nodeValue);
        if (!text || !node.parentElement || !shown(node.parentElement)) continue;
        yield { text, element: owner(node.parentElement) };
      }
    }
  };
  /** The element a person means by these words: controls first, then any visible text; on a tie the one on screen. */
  const findByLabel = (label) => {
    let best = null, bestScore = 0, bestInView = false;
    const consider = (element, value) => {
      if (value < 1) return;
      const visible = inView(element);
      if (value > bestScore || (value === bestScore && visible && !bestInView)) { best = element; bestScore = value; bestInView = visible; }
    };
    for (const candidate of all(interactiveQuery)) {
      if (!shown(candidate)) continue;
      consider(candidate, score(nameOf(candidate), label));
      if (bestScore === 5 && bestInView) return best;
    }
    if (bestScore < 5) for (const { text, element } of textNodes()) consider(element, score(text, label));
    return best;
  };
  /** Up to `limit` visible names closest to the wanted words (shared words), for a "did you mean" answer. */
  const similar = (label, limit) => {
    const words = new Set(norm(label).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1));
    if (!words.size) return [];
    const seen = new Set();
    const ranked = [];
    const add = (element, text) => {
      if (seen.has(element)) return;
      seen.add(element);
      const theirs = new Set(norm(text).split(/[^\p{L}\p{N}]+/u));
      let shared = 0;
      for (const word of words) if (theirs.has(word)) shared++;
      if (shared) ranked.push({ shared, text: clean(text).slice(0, 80), ...center(element) });
    };
    for (const candidate of all(interactiveQuery)) if (shown(candidate)) add(candidate, nameOf(candidate));
    for (const { text, element } of textNodes()) add(element, text);
    return ranked.sort((a, b) => b.shared - a.shared).slice(0, limit).map(({ shared, ...rest }) => rest);
  };
  /** Visible elements whose text contains the words, each once, on-screen ones first. */
  const findText = (text, limit, matchCase) => {
    const want = matchCase ? clean(text) : norm(text);
    const out = [];
    const seen = new Set();
    for (const node of textNodes()) {
      const have = matchCase ? node.text : norm(node.text);
      if (!have.includes(want) || seen.has(node.element)) continue;
      seen.add(node.element);
      out.push({ ...describe(node.element), text: node.text.slice(0, 120), ...center(node.element), inView: inView(node.element) });
    }
    return out.sort((a, b) => Number(b.inView) - Number(a.inView)).slice(0, limit);
  };
  const scrollable = (element, axis) => {
    if (!element || element.nodeType !== 1) return false;
    const page = element === document.scrollingElement;
    const style = getComputedStyle(element);
    const overflow = axis === 'x' ? style.overflowX : style.overflowY;
    const room = axis === 'x' ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
    return room > 1 && (page || /(auto|scroll|overlay)/.test(overflow));
  };
  /** The area that scrolls `element` (itself or the nearest ancestor that can), or the page. */
  const scrollerOf = (element, axis) => {
    for (let node = element; node; node = parentOf(node)) if (scrollable(node, axis)) return node;
    return scrollable(document.scrollingElement, axis) ? document.scrollingElement : null;
  };
  /** Without a point or element: the largest visible scrolling area (an app's main list), else the page. */
  const mainScroller = (axis) => {
    if (scrollable(document.scrollingElement, axis)) return document.scrollingElement;
    let best = null, bestArea = 0;
    for (const element of all('*')) {
      if (!scrollable(element, axis) || !inView(element)) continue;
      const rect = element.getBoundingClientRect();
      const area = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      if (area > bestArea) { best = element; bestArea = area; }
    }
    return best;
  };
  return { INTERACTIVE: interactiveQuery, all, query, fromPoint, contains, activeElement, shown, center, inView, clean, nameOf, describe, findByLabel, similar, findText, scrollerOf, mainScroller };
}

/** Find one element by index, selector or label, scroll it to the middle unless asked not to, and report its centre. */
function pageLocate(h, q) {
  let element;
  if (Number.isInteger(q.index)) element = h.all(h.INTERACTIVE)[q.index];
  else if (q.selector) element = h.query(q.selector);
  else if (q.label) element = h.findByLabel(q.label);
  if (!element) {
    if (Number.isInteger(q.index)) return { ok: false, error: `no interactive element at index ${q.index}` };
    if (q.selector) return { ok: false, error: `no element matches ${q.selector}` };
    const near = h.similar(q.label, 5);
    return { ok: false, error: `nothing visible on the page reads ${JSON.stringify(q.label)}${near.length ? `; closest visible texts: ${near.map((item) => `${JSON.stringify(item.text)} @(${item.x}, ${item.y})`).join(', ')}` : ''}` };
  }
  Object.defineProperty(window, '__myharnessTarget', { value: element, configurable: true, writable: true, enumerable: false });
  if (q.scroll !== false) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = element.getBoundingClientRect();
  const { x, y } = h.center(element);
  const inView = rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  const hit = inView ? h.fromPoint(x, y) : null;
  const covered = inView && hit && !(h.contains(element, hit) || h.contains(hit, element)) ? h.describe(hit) : undefined;
  return { ok: true, x, y, inView, covered, ...h.describe(element), disabled: !!element.disabled, select: element.tagName === 'SELECT', editable: !!(element.isContentEditable || /^(INPUT|TEXTAREA)$/.test(element.tagName)) };
}

function pageInteractive(h) {
  return h.all(h.INTERACTIVE).slice(0, 600).map((element, index) => {
    const rect = element.getBoundingClientRect();
    const visible = h.shown(element);
    return {
      index,
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || '',
      role: element.getAttribute('role') || '',
      label: h.nameOf(element).slice(0, 120),
      name: element.getAttribute('name') || '',
      id: element.id || '',
      href: element.getAttribute('href') || '',
      value: /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) && element.type !== 'password' ? String(element.value ?? '').slice(0, 80) : undefined,
      checked: element.type === 'checkbox' || element.type === 'radio' ? !!element.checked : element.getAttribute('aria-checked') === 'true' ? true : undefined,
      disabled: !!element.disabled || element.getAttribute('aria-disabled') === 'true',
      visible,
      inView: visible && h.inView(element),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  });
}

/** Whether the wait condition holds now. */
function pageWaitCondition(h, q) {
  if (q.selector) { const element = h.query(q.selector); if (!element || !h.shown(element)) return false; }
  if (q.text && !((document.body && document.body.innerText.includes(q.text)) || h.findText(q.text, 1, true).length)) return false;
  if (q.label && !h.findByLabel(q.label)) return false;
  return true;
}

function pageFindText(h, q) {
  return h.findText(q.text, q.limit, q.matchCase);
}

/** Whether these words are on screen now (in the viewport); the matching element with its centre. */
function pageTextOnScreen(h, q) {
  const hit = h.findText(q.text, 1, false)[0];
  return hit && hit.inView ? hit : null;
}

/**
 * Scroll once: the area under a point, the area holding the located element (`window.__myharnessTarget`), or the
 * page's main scrolling area. `dy`/`dx` are pixels; 'page' is most of the area's height. Reports how far it moved,
 * whether it reached the end, and the area's centre (where a wheel goes when the area scrolls by script only).
 */
function pageScroll(h, q) {
  const axis = q.dy || q.dirY ? 'y' : 'x';
  const base = q.target ? window.__myharnessTarget : q.point ? h.fromPoint(q.point.x, q.point.y) : null;
  const box = base ? h.scrollerOf(base, axis) : h.mainScroller(axis);
  const textOf = (element) => (element === document.scrollingElement ? document.body : element)?.innerText?.slice(0, 4000) || '';
  if (!box) {
    const at = base ? h.center(base) : { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) };
    return { ok: true, moved: 0, atEnd: false, container: null, x: q.point ? q.point.x : at.x, y: q.point ? q.point.y : at.y, text: textOf(base || document.scrollingElement) };
  }
  const page = box === document.scrollingElement;
  const amount = (value, size) => (value === 'page' ? Math.max(120, Math.round(size * 0.8)) : Number(value) || 0);
  const dy = amount(q.dy, page ? innerHeight : box.clientHeight);
  const dx = amount(q.dx, page ? innerWidth : box.clientWidth);
  const top = box.scrollTop, left = box.scrollLeft;
  box.scrollBy({ top: dy, left: dx, behavior: 'instant' });
  const moved = Math.round(Math.abs(box.scrollTop - top) + Math.abs(box.scrollLeft - left));
  // The direction asked for decides which end counts; a measuring call (no amount) passes it as dirY/dirX.
  const sy = q.dirY !== undefined ? q.dirY : Math.sign(dy);
  const sx = q.dirX !== undefined ? q.dirX : Math.sign(dx);
  const atEnd = sy > 0 ? box.scrollTop + box.clientHeight >= box.scrollHeight - 2 : sy < 0 ? box.scrollTop <= 0 : sx > 0 ? box.scrollLeft + box.clientWidth >= box.scrollWidth - 2 : box.scrollLeft <= 0;
  const at = page ? { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) } : h.center(box);
  return { ok: true, moved, atEnd, container: page ? { page: true } : h.describe(box), x: q.point ? q.point.x : at.x, y: q.point ? q.point.y : at.y, top: Math.round(box.scrollTop), left: Math.round(box.scrollLeft), text: textOf(box) };
}

/** Before typing into the focused element: select what it holds (form fields always, rich editors only when asked). */
function pageSelectFocused(h, q) {
  const element = h.activeElement();
  if (!element || element === document.body) return null;
  if (/^(INPUT|TEXTAREA)$/.test(element.tagName) && typeof element.select === 'function') element.select();
  else if (element.isContentEditable && q.richToo) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}

function pageFocused(h) {
  const element = h.activeElement();
  if (!element || element === document.body) return null;
  return { tag: element.tagName.toLowerCase(), id: element.id || undefined, value: String(element.value ?? element.innerText ?? '').slice(0, 200) };
}

/**
 * The page script that runs `fn(helpers, arg)`. A thrown error (an invalid selector) comes back as `{ ok: false, error }`
 * instead of the engine's generic "Script failed to execute".
 */
const inPage = (fn, arg) => `(() => { try { return (${fn})((${pageHelpers})(${JSON.stringify(INTERACTIVE_QUERY)}), ${JSON.stringify(arg ?? null)}); } catch (error) { return { ok: false, error: String(error && error.message ? error.message : error) }; } })()`;

module.exports = { INTERACTIVE_QUERY, pageHelpers, inPage, pageLocate, pageInteractive, pageWaitCondition, pageFindText, pageTextOnScreen, pageScroll, pageSelectFocused, pageFocused };
