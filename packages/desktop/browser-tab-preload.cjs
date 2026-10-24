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
