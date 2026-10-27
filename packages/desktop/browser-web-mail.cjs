// Which mailbox websites the built-in browser is signed in to: Settings → Connections shows "Signed in" for Gmail and
// Outlook once the user has signed in on their website in a tab. Google's own sign-in cookies decide for Gmail (their
// names only, never a value) and Gmail's Atom feed, asked with the browser's cookies, names the address. Outlook has no
// such answer — its web app gives every visitor the same start page — so for Outlook the browser goes by what a tab
// last showed: its mail page titled "Mail - <name> - Outlook" means signed in, a tab sent from its mail address to a
// Microsoft sign-in page means signed out. An open tab showing a mailbox wins over both. Only the provider, the
// address or name shown and the time are kept, in browser-web-mail.json of the desktop profile.
const { readFileSync, writeFileSync, renameSync, existsSync } = require('node:fs');

const PROVIDERS = ['google', 'microsoft'];
const GMAIL_FEED = 'https://mail.google.com/mail/u/0/feed/atom';
const EMAIL = /[\w.+%-]+@[\w-]+(?:\.[\w-]+)+/;
// Cookies Google sets on .google.com for a signed-in account and removes on sign-out.
const GOOGLE_SIGNED_IN = new Set(['SID', '__Secure-1PSID', '__Secure-3PSID']);
const OUTLOOK_HOSTS = new Set(['outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft']);
const MICROSOFT_SIGN_IN = new Set(['login.live.com', 'login.microsoftonline.com', 'login.microsoft.com']);

const urlOf = (value) => {
  try { return new URL(String(value || '')); } catch { return null; }
};

/**
 * What a tab with this address and title says about a mailbox, or null when it says nothing: `{ provider, signedIn,
 * account? }`. `from` is the address the tab showed before this one (a sign-out shows as a move from the mailbox to a
 * sign-in page); a title is read only together with the address of the page it belongs to.
 */
function webMailFromTab(url, title, from) {
  const at = urlOf(url);
  if (!at) return null;
  const host = at.hostname.toLowerCase();
  const path = at.pathname.toLowerCase();
  const text = String(title || '');
  if (host === 'mail.google.com' && path.startsWith('/mail')) {
    const address = EMAIL.exec(text)?.[0];
    return address ? { provider: 'google', signedIn: true, account: address } : null;
  }
  if (OUTLOOK_HOSTS.has(host)) {
    if (/\/(?:logoff|logout|signout)/.test(path)) return { provider: 'microsoft', signedIn: false };
    if (!path.startsWith('/mail')) return null;
    const parts = text.split(/\s+[-–—]\s+/);
    if (parts.length >= 3 && /^outlook$/i.test(parts[parts.length - 1].trim())) {
      const account = parts[parts.length - 2].trim();
      return { provider: 'microsoft', signedIn: true, ...(account ? { account } : {}) };
    }
    return null;
  }
  const before = urlOf(from);
  const fromOutlook = !!before && OUTLOOK_HOSTS.has(before.hostname.toLowerCase());
  if (fromOutlook && (MICROSOFT_SIGN_IN.has(host) || (/(^|\.)microsoft\.com$/.test(host) && path.includes('outlook')))) return { provider: 'microsoft', signedIn: false };
  return null;
}

/**
 * The signed-in state of each mailbox website. `cookies(url)` lists the browser's cookies for a URL and `fetch` asks a
 * URL with them (both from the tabs' session); `openTabs()` gives the address and title of every open tab.
 */
function createWebMailState({ file, cookies, fetch, openTabs = () => [], log = () => undefined, now = Date.now, gmailFeed = GMAIL_FEED }) {
  const read = () => {
    try {
      if (file && existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        const out = {};
        for (const provider of PROVIDERS) {
          const entry = saved?.[provider];
          if (entry && typeof entry.signedIn === 'boolean') out[provider] = { signedIn: entry.signedIn, ...(typeof entry.account === 'string' && entry.account ? { account: entry.account } : {}), at: Number(entry.at) || 0 };
        }
        return out;
      }
    } catch (error) {
      log(`读取网页邮箱登录状态失败：${error.message}`);
    }
    return {};
  };
  let seen = read();
  const save = () => {
    if (!file) return;
    try {
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, ...seen }, null, 2));
      renameSync(temp, file);
    } catch (error) {
      log(`保存网页邮箱登录状态失败：${error.message}`);
    }
  };
  /** Keeps what a tab showed; true when it changed what is known. */
  const remember = (found) => {
    if (!found) return false;
    const old = seen[found.provider];
    const account = found.signedIn ? found.account || (old?.signedIn ? old.account : undefined) : undefined;
    if (old && old.signedIn === found.signedIn && old.account === account) return false;
    seen = { ...seen, [found.provider]: { signedIn: found.signedIn, ...(account ? { account } : {}), at: now() } };
    save();
    return true;
  };
  const fromOpenTabs = () => {
    const out = {};
    for (const tab of openTabs()) {
      const found = webMailFromTab(tab.url, tab.title);
      if (found?.signedIn && !out[found.provider]) out[found.provider] = found;
    }
    return out;
  };
  const gmailAddress = async () => {
    try {
      const response = await fetch(gmailFeed, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) return undefined;
      const title = /<title>([^<]*)<\/title>/i.exec(await response.text())?.[1] ?? '';
      return EMAIL.exec(title)?.[0];
    } catch {
      return undefined;
    }
  };
  const google = async () => {
    let names;
    try {
      names = (await cookies('https://mail.google.com/')).map((cookie) => cookie.name);
    } catch {
      names = undefined;
    }
    // The cookies could not be read: what was seen last stands.
    if (!names) return seen.google ?? { signedIn: false };
    if (!names.some((name) => GOOGLE_SIGNED_IN.has(name))) {
      remember({ provider: 'google', signedIn: false });
      return { signedIn: false };
    }
    const address = await gmailAddress();
    remember({ provider: 'google', signedIn: true, account: address });
    return seen.google;
  };
  return {
    /** A tab showed `url` with `title` (`from`: the address it showed before); true when the known state changed. */
    observe: (url, title, from) => remember(webMailFromTab(url, title, from)),
    /** `{ google, microsoft }`, each `{ signedIn, account? }`. */
    async state() {
      const open = fromOpenTabs();
      for (const found of Object.values(open)) remember(found);
      const gmail = open.google ?? (await google());
      const outlook = open.microsoft ?? seen.microsoft ?? { signedIn: false };
      const clean = (entry) => ({ signedIn: !!entry?.signedIn, ...(entry?.signedIn && entry.account ? { account: entry.account } : {}) });
      return { google: clean(gmail), microsoft: clean(outlook) };
    },
  };
}

module.exports = { createWebMailState, webMailFromTab, GMAIL_FEED };
