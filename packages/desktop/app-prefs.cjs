// Preferences of the desktop host itself (not of the Web UI): what the window's close button does, and whether
// MyHarness starts when the user signs in to Windows. They live in the host profile next to the browser data, so a
// development run and the installed app keep their own copies. Start-at-login is not stored here: Windows' own Run
// entry is the truth, read back through Electron every time.
const { readFileSync, writeFileSync, renameSync } = require('node:fs');
const { join } = require('node:path');

const CLOSE_ACTIONS = ['ask', 'tray', 'quit'];
const DEFAULTS = Object.freeze({ closeAction: 'ask' });

function createAppPrefs(profileDir) {
  const file = join(profileDir, 'desktop-prefs.json');
  let prefs = { ...DEFAULTS };
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (CLOSE_ACTIONS.includes(saved?.closeAction)) prefs.closeAction = saved.closeAction;
  } catch { /* missing or unreadable: defaults */ }
  return {
    get: () => ({ ...prefs }),
    /** Merges the known keys of `patch` (unknown keys and invalid values are refused) and writes the file atomically. */
    set(patch) {
      if (!patch || typeof patch !== 'object') throw new Error('无效的桌面设置');
      const next = { ...prefs };
      if ('closeAction' in patch) {
        if (!CLOSE_ACTIONS.includes(patch.closeAction)) throw new Error('未知的关闭方式');
        next.closeAction = patch.closeAction;
      }
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify(next, null, 2));
      renameSync(temp, file);
      prefs = next;
      return { ...prefs };
    },
  };
}

/**
 * The Run entry that starts this app at sign-in. A development run is electron.exe plus the app folder; the installed
 * app is its own executable. `--autostart` lets the host tell a sign-in start from one the user made.
 */
function loginItem(app) {
  return { path: process.execPath, args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--autostart'] };
}

module.exports = { createAppPrefs, loginItem, CLOSE_ACTIONS };
