// Sign-in helper of the built-in browser's site tabs. It runs in the tab's isolated world (the site's scripts cannot see
// or call it) and only talks to the desktop host: it reports a submitted login so the host can save it once the sign-in
// looked successful, and fills a login form with a login saved for this exact site. On its own it never presses the
// site's button; only a sign-in the Agent asks for on a bookmarked site submits the form. Passwords are never written to
// the console, the DOM attributes or the URL, and never sent to the Agent.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// ---- Window drag areas -------------------------------------------------------------------------------------------
// A site's `-webkit-app-region: drag` (written for installed web apps and desktop shells) is honoured by the frameless
// app window as its own title bar: a click there moves the whole window and a double-click maximizes it, so the page
// never sees either. A user-origin `!important` rule outranks every author rule, inline ones included. It is inserted
// before the first layout, because the engine only re-reads drag areas on a layout change.
try { webFrame.insertCSS('*, *::before, *::after { -webkit-app-region: no-drag !important; }', { cssOrigin: 'user' }); } catch { /* frame is going away */ }

// ---- Engine identity ---------------------------------------------------------------------------------------------
// The engine reports itself as Chromium in its client hints, while on a few sites the user agent of this tab is Chrome's
// (WhatsApp Web and Teams refuse the Electron token; see CHROME_UA_SITES in browser-view.cjs). A real Chrome lists its
// own brand next to Chromium, so on those pages the two signals would disagree in a way no ordinary browser does. The
// brand is *added* to the engine's own list on `NavigatorUAData.prototype`: every value the page reads is still a real
// NavigatorUAData with its native type, and only the brand list gains the entry a real Chrome reports. A page that
// sends the engine's own user agent (it names Electron) is left completely untouched.
const chromeBrand = (() => {
  const agent = navigator.userAgent || '';
  const match = /Chrome\/(\d+)\./u.exec(agent);
  return match && !/\bElectron\//u.test(agent) ? { brand: 'Google Chrome', version: match[1] } : null;
})();
if (chromeBrand) {
  try {
    contextBridge.executeInMainWorld({
      func: (brand) => {
        const proto = typeof NavigatorUAData === 'function' ? NavigatorUAData.prototype : null;
        if (!proto) return;
        const addBrand = (list) => {
          if (!Array.isArray(list)) return list;
          if (list.some((item) => /Google Chrome/iu.test(String(item && item.brand ? item.brand : '')))) return list;
          return Object.freeze([...list.map((item) => Object.freeze({ ...item })), Object.freeze({ ...brand })]);
        };
        try {
          const brands = Object.getOwnPropertyDescriptor(proto, 'brands');
          if (brands && typeof brands.get === 'function') {
            const native = brands.get;
            Object.defineProperty(proto, 'brands', {
              configurable: brands.configurable !== false,
              enumerable: brands.enumerable,
              get() {
                return addBrand(native.call(this));
              },
            });
          }
          const high = Object.getOwnPropertyDescriptor(proto, 'getHighEntropyValues');
          if (high && typeof high.value === 'function') {
            const native = high.value;
            Object.defineProperty(proto, 'getHighEntropyValues', {
              configurable: high.configurable !== false,
              enumerable: high.enumerable,
              writable: high.writable !== false,
              // The keys stay the ones the engine answered with; only a list the answer already carries gains the brand.
              value: async function getHighEntropyValues(hints) {
                const values = await native.call(this, hints);
                if (!values || typeof values !== 'object') return values;
                const next = { ...values };
                if (Array.isArray(next.brands)) next.brands = addBrand(next.brands);
                if (Array.isArray(next.fullVersionList)) next.fullVersionList = addBrand(next.fullVersionList);
                return next;
              },
            });
          }
        } catch {
          // A frozen or exotic implementation keeps its own hints; nothing else changes.
        }
      },
      args: [chromeBrand],
    });
  } catch {
    // An engine without the main-world bridge keeps its own client hints; nothing else changes.
  }
}

// ---- Language -----------------------------------------------------------------------------------------------------
// The language chosen in the browser toolbar (browser-language.cjs) also reaches what the page's scripts read:
// navigator.language and navigator.languages say the same as the Accept-Language header. Nothing is changed when the
// browser keeps the engine's default.
(() => {
  let languages = null;
  try { languages = ipcRenderer.sendSync('mh-browser:languages'); } catch { languages = null; }
  if (!Array.isArray(languages) || !languages.length) return;
  try {
    contextBridge.executeInMainWorld({
      func: (list) => {
        const proto = Navigator.prototype;
        const frozen = Object.freeze([...list]);
        for (const [name, value] of [['language', list[0]], ['languages', frozen]]) {
          const own = Object.getOwnPropertyDescriptor(proto, name);
          if (!own || own.configurable === false) continue;
          Object.defineProperty(proto, name, { configurable: true, enumerable: own.enumerable, get: () => value });
        }
      },
      args: [languages],
    });
  } catch {
    // An engine without the main-world bridge keeps its own navigator languages; the header still says the choice.
  }
})();

// ---- Dark mode ----------------------------------------------------------------------------------------------------
// The host runs Dark Reader's engine in this same isolated world (browser-dark.cjs). To recolor cross-origin
// stylesheets and images it must read them; the host fetches those through this tab's session, without CORS. The
// site's scripts live in another world and cannot reach this function.
globalThis.__myharnessDarkFetch = (url) => ipcRenderer.invoke('mh-browser:dark-fetch', String(url));

// Frames of the page's own site share this renderer; the host recolors them through this (browser-dark.cjs
// applyDarkToFrames). The script runs in the frame's own isolated world, unless the small `settled` check finds the
// frame already in the wanted state. Resolves with the number of frames the script reported success in.
globalThis.__myharnessDarkFrames = async (tokens, code, settled) => {
  let count = 0;
  for (const token of Array.isArray(tokens) ? tokens : []) {
    let frame = null;
    try { frame = webFrame.findFrameByToken(String(token)); } catch { frame = null; }
    if (!frame) continue;
    try {
      if (settled && (await frame.executeJavaScriptInIsolatedWorld(999, [{ code: settled }])) === true) continue;
      if ((await frame.executeJavaScriptInIsolatedWorld(999, [{ code }])) === true) count += 1;
    } catch { /* the frame went away */ }
  }
  return count;
};

// A page that will be shown dark gets a dark canvas before its first paint, so it never flashes white while it loads;
// the host says when the engine has taken over (or the page stays in its own colors) and the canvas goes.
(() => {
  if (!/^https?:$/u.test(location.protocol)) return;
  let css = '';
  try { css = ipcRenderer.sendSync('mh-browser:dark-early', location.href) || ''; } catch { css = ''; }
  if (!css) return;
  const style = document.createElement('style');
  style.textContent = css;
  const attach = () => (document.head || document.documentElement)?.append(style);
  if (document.documentElement) attach();
  else {
    // The root element appears as parsing starts, long before readystatechange (which waits for the whole body).
    const watch = new MutationObserver(() => {
      if (!document.documentElement) return;
      watch.disconnect();
      if (!style.isConnected && globalThis.__myharnessDarkCanvas === style) attach();
    });
    watch.observe(document, { childList: true });
  }
  // The host's native-dark check sets this canvas aside for one read (browser-dark.cjs detectNativeDark).
  globalThis.__myharnessDarkCanvas = style;
  ipcRenderer.once('mh-browser:dark-settled', () => { style.remove(); globalThis.__myharnessDarkCanvas = null; });
})();

// ---- Selection translation ---------------------------------------------------------------------------------------
// Select text on a page and a small "译" button appears beside it (or right-click → 翻译所选文字); the translation comes
// from the app's own service (Settings → Agent → Assistants → Translation), asked for through the host. The button and the card live
// in a closed shadow root: the site's scripts and styles (Dark Reader's too) cannot read or restyle them, and the
// answer is only ever written as text.
const MAX_TRANSLATION_CHARS = 6000;
const translator = (() => {
  let host = null;
  let root = null;
  let bubble = null;
  let card = null;
  let seq = 0;
  let lastLook = null;
  let state = null;
  // The language translations go into ({ preference, target }), kept between cards and read again when one opens.
  let language = null;
  // The languages of Settings → Agent → Assistants → Translation; "auto" is the interface language.
  const TARGETS = [['auto', '跟随界面语言'], ['zh-CN', '简体中文'], ['zh-TW', '繁体中文'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语'], ['fr', '法语'], ['de', '德语'], ['es', '西班牙语'], ['ru', '俄语']];
  const SOURCES = { zh: '中文', en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语', ru: '俄语' };
  const languageName = (tag) => {
    const known = TARGETS.find(([value]) => value === tag);
    if (known) return known[1];
    return SOURCES[String(tag || '').split('-')[0]] || String(tag || '');
  };
  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif; }
    .bubble, .card { position: fixed; z-index: 2147483647; background: var(--bg); color: var(--fg); border: 1px solid var(--line); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28); }
    .bubble { display: flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border-radius: 8px; font-size: 12.5px; cursor: pointer; user-select: none; animation: pop .14s ease both; }
    .bubble:hover { color: var(--accent); }
    .card { width: 360px; max-width: calc(100vw - 16px); padding: 6px 10px 8px; border-radius: 10px; font-size: 13.5px; line-height: 1.6; outline: none; animation: pop .16s ease both; display: flex; flex-direction: column; gap: 8px; }
    .card.leaving { animation: leave .14s ease both; pointer-events: none; }
    @keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(.97); } to { opacity: 1; transform: none; } }
    @keyframes leave { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-3px) scale(.98); } }
    .head { display: flex; align-items: center; gap: 6px; min-height: 26px; font-size: 12px; color: var(--dim); cursor: grab; user-select: none; touch-action: none; }
    .card.dragging .head { cursor: grabbing; }
    .logo { color: var(--accent); font-weight: 700; }
    .pair { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
    .src { max-width: 90px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .lang { display: inline-flex; align-items: center; gap: 3px; height: 22px; padding: 0 8px; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--fg); font-size: 12px; cursor: pointer; }
    .lang:hover, .lang.open { background: var(--hover); }
    .grow { flex: 1; }
    .head .btn { border: 0; background: transparent; color: var(--dim); font-size: 12px; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
    .head .btn:hover { background: var(--hover); color: var(--fg); }
    .menu { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 4px; border: 1px solid var(--line); border-radius: 8px; animation: pop .12s ease both; }
    .menu button { height: 26px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: var(--dim); font-size: 12px; text-align: left; cursor: pointer; }
    .menu button:hover { background: var(--hover); color: var(--fg); }
    .menu button.on { color: var(--accent); }
    .body { max-height: min(50vh, 380px); overflow: auto; overflow-wrap: anywhere; user-select: text; }
    .dim { color: var(--dim); }
    .error { color: #e5484d; white-space: pre-wrap; }
    .term { font-size: 1.15em; font-weight: 650; }
    .speak { border: 0; background: transparent; color: var(--dim); cursor: pointer; font-size: 13px; padding: 0 4px; }
    .speak:hover { color: var(--accent); }
    .phonetic { color: var(--dim); font-size: 12px; }
    .voices { display: flex; flex-wrap: wrap; gap: 2px 14px; align-items: center; }
    .voice { display: inline-flex; align-items: center; gap: 4px; }
    .accent { font-size: 12px; }
    .main { font-size: 1.05em; font-weight: 600; color: var(--accent); white-space: pre-wrap; }
    .senses { list-style: none; margin: 4px 0 0; padding: 6px 0 0; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; }
    .senses li { display: flex; align-items: baseline; gap: 8px; }
    .pos { flex: none; min-width: 30px; padding: 0 5px; border-radius: 4px; background: var(--hover); color: var(--dim); font-size: 11px; font-style: italic; text-align: center; line-height: 18px; }
    .source { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; padding-bottom: 6px; margin-bottom: 6px; border-bottom: 1px dashed var(--line); color: var(--dim); font-size: 12px; line-height: 1.5; white-space: pre-wrap; cursor: pointer; }
    .source.open { -webkit-line-clamp: unset; }
    .target { white-space: pre-wrap; }
    .foot { font-size: 10.5px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media (prefers-reduced-motion: reduce) { .bubble, .card, .card.leaving, .menu { animation: none; } }
  `;
  const ensure = () => {
    if (host?.isConnected) return;
    host = document.createElement('myharness-translate');
    host.setAttribute('style', 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;');
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.append(style);
    (document.documentElement || document.body).append(host);
  };
  const theme = (look) => {
    const dark = look?.dark !== false;
    const color = (value, fallback) => (typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback);
    host.style.setProperty('--bg', dark ? color(look?.background, '#262727') : '#ffffff');
    host.style.setProperty('--fg', dark ? color(look?.text, '#e3e3e3') : '#1f1f1f');
    host.style.setProperty('--dim', dark ? '#a0a0a0' : '#6b6b6b');
    host.style.setProperty('--line', dark ? '#3a3b3b' : '#dcdcdc');
    host.style.setProperty('--hover', dark ? '#343535' : '#f0f0f0');
    host.style.setProperty('--accent', dark ? '#8ab4f8' : '#1a73e8');
  };
  const place = (element, x, y, width, height) => {
    const left = Math.max(8, Math.min(x, innerWidth - width - 8));
    const below = y + 8 + height <= innerHeight - 8;
    element.style.left = `${left}px`;
    element.style.top = `${below ? y + 8 : Math.max(8, y - height - 8)}px`;
  };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const hideBubble = () => { bubble?.remove(); bubble = null; };
  /** Close at once (a new card replaces it) or with the fade-out. */
  const close = (animated = false) => {
    seq += 1;
    hideBubble();
    const old = card;
    card = null;
    state = null;
    if (!old) return;
    if (!animated || matchMedia('(prefers-reduced-motion: reduce)').matches) return old.remove();
    old.classList.add('leaving');
    setTimeout(() => old.remove(), 150);
  };
  const inside = (event) => !!host && event.composedPath().includes(host);
  /** The selected text, when it is page text (not typed into a field) and short enough. */
  const selectedText = () => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
    const node = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
    if (node?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return '';
    const text = selection.toString().trim();
    return text && text.length <= MAX_TRANSLATION_CHARS ? text : '';
  };
  const endOfSelection = () => {
    const selection = getSelection();
    if (!selection?.rangeCount) return null;
    const rects = selection.getRangeAt(0).getClientRects();
    const last = rects[rects.length - 1];
    return last ? { x: last.right, y: last.bottom } : null;
  };
  const showBubble = (text, x, y) => {
    ensure();
    hideBubble();
    bubble = el('div', 'bubble', '译 翻译');
    bubble.setAttribute('role', 'button');
    bubble.title = '翻译所选文字';
    bubble.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
    bubble.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void open(text, x, y); });
    root.append(bubble);
    theme(lastLook);
    place(bubble, x, y, 80, 28);
  };
  /** The head drags the card; once moved it stays where it was put. */
  const draggable = (head) => {
    head.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.composedPath().some((node) => node instanceof HTMLButtonElement)) return;
      const target = card;
      if (!target) return;
      event.preventDefault();
      const box = target.getBoundingClientRect();
      const dx = event.clientX - box.left;
      const dy = event.clientY - box.top;
      head.setPointerCapture(event.pointerId);
      target.classList.add('dragging');
      const move = (e) => {
        target.style.left = `${Math.max(4, Math.min(innerWidth - box.width - 4, e.clientX - dx))}px`;
        target.style.top = `${Math.max(4, Math.min(innerHeight - 40, e.clientY - dy))}px`;
        target.dataset.placed = '1';
      };
      const end = () => {
        target.classList.remove('dragging');
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', end);
        head.removeEventListener('pointercancel', end);
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', end);
      head.addEventListener('pointercancel', end);
    });
  };
  let player = null;
  const speak = (text, lang) => {
    // Only the language leaves Windows on its default voice: British and American would sound the same.
    const wanted = String(lang || '').toLowerCase();
    const tagOf = (item) => String(item.lang || '').toLowerCase().replace('_', '-');
    const voices = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
    const voice = wanted ? voices.find((item) => tagOf(item) === wanted) || (wanted.includes('-') ? null : voices.find((item) => tagOf(item).startsWith(`${wanted}-`))) : null;
    const say = () => {
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        if (lang) utterance.lang = lang;
        if (voice) utterance.voice = voice;
        speechSynthesis.cancel();
        speechSynthesis.speak(utterance);
      } catch { /* No speech on this system. */ }
    };
    // British and American readings both come from the dictionary voice through the host, even with an installed voice
    // of that accent (an en-GB system voice is much quieter than the recorded US one), played from its bytes (Web Audio)
    // so the site's media policy cannot block it. The system voice is the fallback.
    const accent = wanted === 'en-gb' ? 'uk' : wanted === 'en-us' ? 'us' : '';
    if (!accent) return say();
    try { speechSynthesis.cancel(); } catch { /* no speech */ }
    ipcRenderer.invoke('mh-browser:translate-voice', { text, accent }).then(async (bytes) => {
      if (!bytes || !bytes.byteLength) return say();
      player = player || new AudioContext();
      const data = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const buffer = await player.decodeAudioData(data);
      const source = player.createBufferSource();
      source.buffer = buffer;
      source.connect(player.destination);
      source.start();
    }).catch(say);
  };
  /** Fill the card from `state` ({ text, status, answer, error, preference, target, menu, showSource, copied }). */
  const render = () => {
    if (!card || !state) return;
    card.replaceChildren();
    const head = el('div', 'head');
    head.title = '拖动可移动';
    const pair = el('span', 'pair');
    const entry = state.status === 'done' ? state.answer?.entry : null;
    pair.append(el('span', 'src', entry?.source ? languageName(entry.source) : '自动检测'), el('span', 'dim', '→'));
    const lang = el('button', `lang${state.menu ? ' open' : ''}`, `${languageName(state.target || state.preference || 'auto')} ▾`);
    lang.title = '翻译成';
    lang.addEventListener('click', () => { state.menu = !state.menu; render(); });
    pair.append(lang);
    const copy = el('button', 'btn', state.copied ? '已复制' : '复制');
    copy.hidden = state.status !== 'done';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(String(state?.answer?.translation || '')).then(() => { if (state) { state.copied = true; render(); } }, () => undefined);
    });
    const shut = el('button', 'btn', '关闭');
    shut.addEventListener('click', () => close(true));
    head.append(el('span', 'logo', '译'), pair, el('span', 'grow'), copy, shut);
    draggable(head);
    card.append(head);
    if (state.menu) {
      const menu = el('div', 'menu');
      for (const [value, label] of TARGETS) {
        const chosen = value === (state.preference || 'auto');
        const item = el('button', chosen ? 'on' : '', `${label}${chosen ? ' ✓' : ''}`);
        item.addEventListener('click', () => {
          state.menu = false;
          if (chosen) return render();
          void translate(state.text, { target: value, remember: true });
        });
        menu.append(item);
      }
      card.append(menu);
    }
    const body = el('div', 'body');
    if (state.status === 'loading') body.append(el('div', 'dim', '翻译中…'));
    else if (state.status === 'error') body.append(el('div', 'error', state.error || '翻译失败。'));
    else if (entry) {
      const speaker = (lang, title) => {
        if (typeof speechSynthesis === 'undefined') return null;
        const say = el('button', 'speak', '🔊');
        say.title = title;
        say.addEventListener('click', () => speak(state.text, lang));
        return say;
      };
      // An English word is read both ways, like a dictionary: British and American, each with its own IPA.
      const english = /^en(?:-|$)/i.test(entry.source || '');
      const word = el('div');
      word.append(el('span', 'term', state.text));
      const say = english ? null : speaker(entry.source, '朗读');
      if (say) word.append(say);
      body.append(word);
      if (english) {
        const voices = el('div', 'voices');
        for (const [label, lang, phonetic, title] of [['英', 'en-GB', entry.phonetic, '英式发音'], ['美', 'en-US', entry.phoneticUs || entry.phonetic, '美式发音']]) {
          const voice = el('span', 'voice');
          voice.append(el('span', 'accent', label));
          if (phonetic) voice.append(el('span', 'phonetic', phonetic));
          const button = speaker(lang, title);
          if (button) voice.append(button);
          voices.append(voice);
        }
        body.append(voices);
      } else if (entry.phonetic) body.append(el('div', 'phonetic', entry.phonetic));
      body.append(el('div', 'main', String(state.answer.translation || '')));
      if (entry.senses?.length) {
        const list = el('ul', 'senses');
        for (const sense of entry.senses) {
          const li = el('li');
          if (sense.pos) li.append(el('span', 'pos', sense.pos));
          li.append(el('span', '', sense.meaning));
          list.append(li);
        }
        body.append(list);
      }
    } else {
      const source = el('div', `source${state.showSource ? ' open' : ''}`, state.text);
      source.title = state.showSource ? '收起' : '展开原文';
      source.addEventListener('click', () => { state.showSource = !state.showSource; render(); });
      body.append(source, el('div', 'target', String(state.answer?.translation || '')));
    }
    card.append(body);
    const model = state.status === 'done' ? String(state.answer?.model || '') : '';
    if (model) {
      const foot = el('div', 'foot', model);
      foot.title = model;
      card.append(foot);
    }
    // A card near the bottom edge grows upward once its real height is known (not one the user put somewhere).
    const box = card.getBoundingClientRect();
    if (!card.dataset.placed && box.bottom > innerHeight - 8) card.style.top = `${Math.max(8, innerHeight - 8 - box.height)}px`;
  };
  const translate = async (text, options = {}) => {
    const id = ++seq;
    state = { ...state, text, status: 'loading', menu: false, copied: false, ...(options.target ? { picked: true, preference: options.target, target: options.target === 'auto' ? state?.target : options.target } : {}) };
    render();
    let answer;
    try { answer = await ipcRenderer.invoke('mh-browser:translate', { text, ...options }); } catch (error) { answer = { ok: false, error: error.message }; }
    if (id !== seq || !card) return;
    if (!answer?.ok) state = { ...state, status: 'error', error: answer?.error };
    else {
      state = { ...state, status: 'done', answer, target: answer.target || state.target, preference: answer.preference || state.preference };
      if (answer.preference) language = { preference: answer.preference, target: answer.target || '' };
    }
    render();
  };
  const open = async (text, x, y) => {
    ensure();
    close();
    const id = seq;
    try { lastLook = await ipcRenderer.invoke('mh-browser:translate-look'); } catch { /* keep the last colors */ }
    if (id !== seq) return;
    theme(lastLook);
    card = el('div', 'card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '翻译');
    card.tabIndex = -1;
    card.addEventListener('mousedown', (event) => event.stopPropagation());
    // Focus moving to something else on the page closes the card (a click on plain text closes it in mousedown below).
    card.addEventListener('focusout', (event) => {
      const next = event.relatedTarget;
      if (next && next !== host && !card?.contains(next)) close(true);
    });
    root.append(card);
    state = { text, status: 'loading', ...(language || {}) };
    place(card, x, y, Math.min(360, innerWidth - 16), 150);
    card.focus({ preventScroll: true });
    const card0 = card;
    ipcRenderer.invoke('mh-browser:translate-language').then((saved) => {
      if (!saved?.preference) return;
      language = { preference: saved.preference, target: saved.target };
      if (card === card0 && state?.status === 'loading' && !state.picked) { state = { ...state, ...language }; render(); }
    }, () => undefined);
    await translate(text);
  };
  document.addEventListener('mousedown', (event) => {
    if (inside(event)) return;
    hideBubble();
    if (card && event.button === 0) close(true);
  }, true);
  document.addEventListener('mouseup', (event) => {
    if (event.button !== 0 || inside(event)) return;
    // The selection is final only after the browser handled the release.
    setTimeout(() => {
      if (card) return;
      const text = selectedText();
      if (text) showBubble(text, event.clientX, event.clientY);
    }, 0);
  }, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(true); }, true);
  // The tab losing the focus (the app itself, another tab, another window) closes the card.
  addEventListener('blur', () => { if (card) close(true); });
  addEventListener('scroll', hideBubble, true);
  addEventListener('pagehide', () => close());
  return {
    /** Right-click → 翻译所选文字: the host's menu passes the text and the click point. */
    fromMenu(text, x, y) {
      const value = String(text || '').trim().slice(0, MAX_TRANSLATION_CHARS);
      if (!value) return;
      const end = endOfSelection();
      void open(value, end ? end.x : x, end ? end.y : y);
    },
  };
})();
ipcRenderer.on('mh-browser:translate-selection', (_event, request) => translator.fromMenu(request?.text, Number(request?.x) || 0, Number(request?.y) || 0));

const USERNAME_TYPES = new Set(['', 'text', 'email', 'tel']);
const USERNAME_HINT = /user|login|email|mail|account|phone|mobile|identifier|帳號|账号|用户名|手机|邮箱/i;

const visible = (element) => {
  if (!element || !element.isConnected || element.disabled) return false;
  if (element.type === 'hidden') return false;
  const style = getComputedStyle(element);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  return element.getClientRects().length > 0;
};

const passwordFields = () => [...document.querySelectorAll('input[type="password"]')].filter(visible);

/** The user name field that belongs to a password field: the closest visible text-like field before it in its form. */
const usernameFieldFor = (password) => {
  const scope = password?.form || document;
  const inputs = [...scope.querySelectorAll('input')].filter((input) => USERNAME_TYPES.has((input.getAttribute('type') || '').toLowerCase()) && visible(input));
  if (!inputs.length) return null;
  const marked = inputs.find((input) => (input.getAttribute('autocomplete') || '').toLowerCase().includes('username'));
  if (marked) return marked;
  if (password) {
    const before = inputs.filter((input) => input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (before.length) return before[before.length - 1];
  }
  return inputs.find((input) => input.type === 'email' || USERNAME_HINT.test(`${input.name} ${input.id} ${input.getAttribute('aria-label') || ''} ${input.placeholder || ''}`)) || null;
};

/** The new password of a sign-up or change form (a value typed twice), otherwise the one password on the form. */
const chosenPassword = (fields) => {
  const values = fields.map((field) => field.value).filter(Boolean);
  if (!values.length) return '';
  const repeated = values.find((value, index) => values.indexOf(value) !== index);
  return repeated || values[values.length - 1];
};

// ---- Saving ------------------------------------------------------------------------------------------------------

let watchTimer = 0;
/**
 * After a submit on a page that stays loaded (a single-page app), wait for the password field to go away and stay away;
 * a form that is still on screen means the sign-in failed or needs another step, and nothing is saved.
 */
const watchSettled = () => {
  clearInterval(watchTimer);
  let quiet = 0;
  let rounds = 0;
  watchTimer = setInterval(() => {
    rounds += 1;
    quiet = passwordFields().length === 0 ? quiet + 1 : 0;
    if (quiet >= 3) {
      clearInterval(watchTimer);
      ipcRenderer.send('mh-browser:form-state', { passwordVisible: false, settled: true });
    } else if (rounds > 40) {
      clearInterval(watchTimer);
    }
  }, 500);
};

const reportAttempt = (origin) => {
  const fields = passwordFields();
  const scoped = origin?.form ? fields.filter((field) => field.form === origin.form) : fields;
  const password = chosenPassword(scoped.length ? scoped : fields);
  if (password) {
    const user = usernameFieldFor(scoped[0] || fields[0]);
    ipcRenderer.send('mh-browser:login-attempt', { username: user ? user.value : '', password });
    watchSettled();
    return;
  }
  // The first step of a two-step sign-in (user name now, password on the next page) only remembers the name.
  const user = usernameFieldFor(null);
  if (user?.value && (user.form ? user.form === origin?.form || !origin?.form : true)) ipcRenderer.send('mh-browser:username', { username: user.value });
};

document.addEventListener('submit', (event) => reportAttempt(event.target), true);
// Many sites sign in from a button's click handler without a real form submit.
document.addEventListener('click', (event) => {
  if (!event.isTrusted) return;
  const button = event.target?.closest?.('button, input[type="submit"], input[type="button"], [role="button"]');
  if (button) reportAttempt(button);
}, true);
document.addEventListener('keydown', (event) => {
  if (!event.isTrusted || event.key !== 'Enter') return;
  const target = event.target;
  if (target instanceof HTMLInputElement) reportAttempt(target);
}, true);

// ---- Filling -----------------------------------------------------------------------------------------------------

let saved = null;
const touched = new WeakSet();
const filled = new WeakSet();

const setValue = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

// A field the user typed into is theirs: it is never overwritten, and a field they cleared is not filled again.
document.addEventListener('input', (event) => {
  if (event.isTrusted && event.target instanceof HTMLInputElement) touched.add(event.target);
}, true);

/** Typing a saved user name fills its password, so every saved account of the site can be chosen. */
document.addEventListener('change', (event) => {
  const input = event.target;
  if (!event.isTrusted || !(input instanceof HTMLInputElement) || !saved?.length) return;
  if (!USERNAME_TYPES.has((input.getAttribute('type') || '').toLowerCase())) return;
  const match = saved.find((entry) => entry.username === input.value.trim());
  if (!match) return;
  const password = passwordFields().find((field) => !field.form || !input.form || field.form === input.form);
  if (!password || (touched.has(password) && password.value)) return;
  setValue(password, match.password);
  filled.add(password);
  ipcRenderer.send('mh-browser:filled', { id: match.id });
}, true);

const fill = async () => {
  const passwords = passwordFields();
  if (!passwords.length) return;
  if (saved === null) {
    try { saved = await ipcRenderer.invoke('mh-browser:credentials'); } catch { saved = []; }
    if (!Array.isArray(saved)) saved = [];
  }
  if (!saved.length) return;
  for (const password of passwordFields()) {
    if (filled.has(password) || touched.has(password) || password.value) continue;
    // A sign-up or change form (more than one password field in it) is not a sign-in; it is left alone.
    if (password.form && password.form.querySelectorAll('input[type="password"]').length > 1) continue;
    if ((password.getAttribute('autocomplete') || '').toLowerCase() === 'new-password') continue;
    const user = usernameFieldFor(password);
    const typed = user && user.value.trim();
    const entry = (typed && saved.find((item) => item.username === typed)) || (!typed || !user ? saved[0] : null);
    if (!entry) continue;
    if (user && !user.value && !touched.has(user)) setValue(user, entry.username);
    setValue(password, entry.password);
    filled.add(password);
    ipcRenderer.send('mh-browser:filled', { id: entry.id });
  }
};

// ---- Signing in for the Agent -----------------------------------------------------------------------------------
// The workspace tool may sign in to a bookmarked site with its saved login. The host asks; this helper fills the saved
// user name (and the password when the page shows its field) and submits the form like its own button would. Two-step
// sign-ins work by asking again on the next page. The answer names the account, never the password.

/** The button that sends a form: its own submit button, else a visible "sign in / next" button near the fields. */
const submitButtonFor = (field) => {
  const scope = field?.form || field?.closest?.('form, [role="form"], [role="dialog"], main, body') || document;
  const buttons = [...scope.querySelectorAll('button, input[type="submit"], input[type="image"], [role="button"]')].filter(visible);
  const typed = buttons.find((button) => (button.getAttribute('type') || '').toLowerCase() === 'submit');
  if (typed) return typed;
  return buttons.find((button) => /log ?in|sign ?in|next|continue|submit|登录|登入|下一步|继续|确定/i.test(`${button.textContent || ''} ${button.value || ''} ${button.getAttribute('aria-label') || ''}`)) || null;
};

const submitFrom = (field) => {
  const button = submitButtonFor(field);
  if (button) {
    button.click();
    return true;
  }
  if (field?.form) {
    if (typeof field.form.requestSubmit === 'function') field.form.requestSubmit();
    else field.form.submit();
    return true;
  }
  return false;
};

ipcRenderer.on('mh-browser:agent-login', async (_event, request) => {
  const requestId = request?.requestId;
  const reply = (value) => ipcRenderer.send('mh-browser:agent-login-result', { requestId, ...value });
  try {
    let logins = [];
    try { logins = await ipcRenderer.invoke('mh-browser:credentials'); } catch { logins = []; }
    if (!Array.isArray(logins) || !logins.length) return reply({ ok: false, reason: 'no saved login for this site' });
    const password = passwordFields()[0];
    const user = usernameFieldFor(password || null);
    const typed = user && user.value.trim();
    const entry = (typed && logins.find((item) => item.username === typed)) || logins[0];
    if (!password && !user) return reply({ ok: false, reason: 'no sign-in form on this page' });
    if (user && user.value.trim() !== entry.username) setValue(user, entry.username);
    if (password) {
      setValue(password, entry.password);
      filled.add(password);
    }
    ipcRenderer.send('mh-browser:filled', { id: entry.id });
    const submitted = request?.submit !== false ? submitFrom(password || user) : false;
    reply({ ok: true, username: entry.username, filledPassword: !!password, submitted });
  } catch (error) {
    reply({ ok: false, reason: String(error?.message || error) });
  }
});

let scheduled = 0;
const schedule = () => {
  if (scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = 0;
    void fill();
  }, 250);
};

const start = () => {
  // The page this navigation produced: does it still show a password field? The host decides from this whether a
  // sign-in submitted on the previous page worked.
  setTimeout(() => ipcRenderer.send('mh-browser:form-state', { passwordVisible: passwordFields().length > 0 }), 1200);
  schedule();
  // Single-page sign-in forms appear after the first paint.
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
