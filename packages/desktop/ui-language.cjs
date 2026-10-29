// Language of the app's own interface (Settings → Appearance → Language) for the few things the desktop host shows
// itself: the starting and error pages, the tray menu, the close question when the page cannot ask, a website's
// right-click menu, its load errors and the selection translator in website tabs. The page keeps the choice in
// <agentDir>/web-ui-prefs.json (packages/coding-agent/src/config/web-prefs.ts). Until the user picks one, the interface
// follows the language of Windows: Simplified Chinese, or English for every other language (systemUiLanguage). The host
// gives that language to the service as MYHARNESS_SYSTEM_LANGUAGE, so the page starts in it too.
const { readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const UI_PREFS_FILE = 'web-ui-prefs.json';

/** 'zh-CN' when the first of `languages` (most preferred first, as Windows lists them) is Simplified Chinese, else 'en'. */
function systemUiLanguage(languages) {
  const first = String((Array.isArray(languages) ? languages[0] : languages) ?? '');
  return /^zh(?:-hans(?:-[a-z0-9]+)*|-(?:cn|sg|my))?$/i.test(first) ? 'zh-CN' : 'en';
}

/** The saved Web UI preferences of `agentDir`, or null when there are none or they cannot be read. */
function readUiPrefs(agentDir) {
  try {
    const prefs = JSON.parse(readFileSync(join(agentDir, UI_PREFS_FILE), 'utf8'))?.prefs;
    return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : null;
  } catch {
    return null;
  }
}

/**
 * 'zh-CN' or 'en': the language saved in the preferences file of `agentDir` (read again only when the file changed), or
 * `fallback()` while none is saved, like the page itself. Preferences that cannot be read count as none saved.
 */
function createUiLanguage(agentDir, fallback = () => 'en') {
  const file = join(agentDir, UI_PREFS_FILE);
  let seen = { mtimeMs: -1, saved: undefined };
  return () => {
    let mtimeMs;
    try { mtimeMs = statSync(file).mtimeMs; } catch { return fallback(); }
    if (mtimeMs !== seen.mtimeMs) {
      const lang = readUiPrefs(agentDir)?.lang;
      seen = { mtimeMs, saved: typeof lang === 'string' ? (lang === 'zh-CN' ? 'zh-CN' : 'en') : undefined };
    }
    return seen.saved ?? fallback();
  };
}

/** `say(english, chinese)` in the interface language of the moment. */
const translator = (uiLanguage) => (english, chinese) => (uiLanguage?.() === 'zh-CN' ? chinese : english);

module.exports = { UI_PREFS_FILE, createUiLanguage, readUiPrefs, systemUiLanguage, translator };
