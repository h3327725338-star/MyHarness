// Help the Agent asks of the user on a website tab: sign in, pass a human check, or another step only a person may take.
// The Agent never answers such a page itself; it asks (`handoff`), the tab shows the request with "Done" / "Not now",
// and the Agent's call waits for the outcome. A human check that goes away by itself ends the wait on its own; so does
// a sign-in that visibly finished (the page left the sign-in pages and stayed away). Nothing here touches the page.

const REASONS = new Set(['login', 'verify', 'other']);
const OUTCOMES = new Set(['done', 'declined']);
const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const MAX_WAIT_MS = 60 * 60 * 1000;
const MIN_WAIT_MS = 30 * 1000;
// A check or sign-in counts as finished only after the page stayed that way this long (a redirect chain passes through
// pages that look finished for a moment).
const VERIFY_SETTLE_MS = 1500;
const LOGIN_SETTLE_MS = 3000;

// Sign-in pages of the big identity providers, wherever their path goes.
const SIGN_IN_HOSTS = /^(accounts\.google\.com|login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|account\.live\.com|appleid\.apple\.com|idmsa\.apple\.com|id\.atlassian\.com|[\w-]+\.okta\.com|[\w-]+\.auth0\.com|passport\.[\w.-]+|sso\.[\w.-]+|login\.[\w.-]+|signin\.[\w.-]+|auth\.[\w.-]+|cas\.[\w.-]+)$/i;
// Paths that name a sign-in step: the form itself and the second steps that follow it (codes, two-factor checks).
const SIGN_IN_PATH = /(^|\/)(log[-_]?in|log[-_]?on|sign[-_]?in|signin|session\/new|sessions?\/two[-_]factor|two[-_]?factor|2fa|mfa|otp|sso|cas|oauth2?\/authori[sz]e|authori[sz]e|auth\/(login|realms))(\/|\.|$)/i;

/** Whether an address is a sign-in page by its name alone (the host or the path says so). */
exports.signInAddress = (value) => {
  let url;
  try { url = new URL(String(value || '')); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  return SIGN_IN_HOSTS.test(url.hostname) || SIGN_IN_PATH.test(url.pathname);
};

const bounded = (value, low, high, fallback) => (Number.isFinite(Number(value)) ? Math.max(low, Math.min(high, Math.round(Number(value)))) : fallback);

/**
 * `commit(tab, patch)` stores a patch on the tab and tells the page; `stateOf(tab)` is the tab's reported state. The
 * desk keeps one request per tab: a new one answers the old as `replaced`.
 */
exports.createHelpDesk = ({ commit, stateOf, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) => {
  const waits = new Map();
  let seq = 0;

  const finish = (tab, outcome) => {
    const wait = waits.get(tab.id);
    if (!wait) return false;
    waits.delete(tab.id);
    clearTimer(wait.timer);
    clearTimer(wait.settle);
    if (!tab.destroyed) commit(tab, { help: null });
    wait.resolve({ ...(tab.destroyed ? { tabId: tab.id } : stateOf(tab)), outcome, reason: wait.reason, waitedMs: Math.max(0, now() - wait.since) });
    return true;
  };

  /** A page that may have finished on its own: settle first, then end the wait. */
  const finishedOnItsOwn = (tab, wait) => {
    if (tab.loading || tab.challenge) return false;
    if (wait.reason === 'verify') return wait.sawChallenge;
    if (wait.reason === 'login') return wait.navigated && !tab.passwordVisible && !exports.signInAddress(tab.url);
    return false;
  };

  return {
    /**
     * Ask the user on this tab. Resolves with the tab's state and `outcome`: done (the user said so), done-auto (the
     * check or sign-in visibly finished), declined, timeout, closed (the tab went away), cancelled (the Agent stopped)
     * or replaced (another request for the same tab).
     */
    ask(tab, value = {}) {
      finish(tab, 'replaced');
      const reason = REASONS.has(value.reason) ? value.reason : tab.challenge ? 'verify' : 'login';
      const message = String(value.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const waitMs = bounded(value.timeoutMs, MIN_WAIT_MS, MAX_WAIT_MS, DEFAULT_WAIT_MS);
      const id = `help-${++seq}`;
      const since = now();
      const chat = typeof value.sessionId === 'string' && value.sessionId ? value.sessionId.slice(0, 200) : undefined;
      const chatTitle = typeof value.chatTitle === 'string' ? value.chatTitle.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
      return new Promise((resolve) => {
        const wait = { id, reason, since, resolve, sawChallenge: !!tab.challenge, navigated: false, url: tab.url, timer: undefined, settle: undefined };
        wait.timer = setTimer(() => finish(tab, 'timeout'), waitMs);
        waits.set(tab.id, wait);
        commit(tab, { help: { id, reason, message, since, until: since + waitMs, ...(chat ? { sessionId: chat } : {}), ...(chatTitle ? { chatTitle } : {}) } });
      });
    },
    /** The page's answer from the request's own buttons; a stale request id is ignored. */
    answer(tab, helpId, outcome) {
      const wait = waits.get(tab.id);
      if (!wait || wait.id !== helpId || !OUTCOMES.has(outcome)) return false;
      return finish(tab, outcome);
    },
    cancel(tab) { return finish(tab, 'cancelled'); },
    closed(tab) { return finish(tab, 'closed'); },
    pending(tab) { return waits.has(tab.id); },
    /** Called after every change of the tab: follows a check or sign-in that finishes without a click. */
    observe(tab) {
      const wait = waits.get(tab.id);
      if (!wait) return;
      if (tab.challenge) wait.sawChallenge = true;
      if (tab.url && tab.url !== wait.url) wait.navigated = true;
      if (!finishedOnItsOwn(tab, wait)) {
        clearTimer(wait.settle);
        wait.settle = undefined;
        return;
      }
      if (wait.settle) return;
      wait.settle = setTimer(() => {
        wait.settle = undefined;
        if (waits.get(tab.id) === wait && finishedOnItsOwn(tab, wait)) finish(tab, 'done-auto');
      }, wait.reason === 'verify' ? VERIFY_SETTLE_MS : LOGIN_SETTLE_MS);
    },
  };
};
