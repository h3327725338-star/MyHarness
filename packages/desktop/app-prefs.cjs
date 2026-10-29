// Preferences of the desktop host itself (not of the Web UI): what the window's close button does, the zoom of the app
// window (Ctrl + "+" / "-" / 0), how long the last start took (the starting page's hint, start-page.cjs), and whether
// MyHarness starts when the user signs in to Windows. They live in the host profile next to the browser data, so a
// development run and the installed app keep their own copies. Start-at-login is not stored here: Windows' own Run
// entry is the truth, read back through Electron every time.
const { readFileSync, writeFileSync, renameSync } = require('node:fs');
const { join } = require('node:path');
const { cleanZoom } = require('./zoom.cjs');

const CLOSE_ACTIONS = ['ask', 'tray', 'quit'];
const DEFAULTS = Object.freeze({ closeAction: 'ask', appZoom: 1, lastStartMs: null });
/** A start time worth keeping: whole milliseconds, more than nothing and less than the host's own 180-second limit. */
const startTime = (value) => (Number.isFinite(value) && value > 0 && value < 180000 ? Math.round(value) : null);

function createAppPrefs(profileDir) {
  const file = join(profileDir, 'desktop-prefs.json');
  let prefs = { ...DEFAULTS };
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (CLOSE_ACTIONS.includes(saved?.closeAction)) prefs.closeAction = saved.closeAction;
    if (saved && 'appZoom' in saved) prefs.appZoom = cleanZoom(saved.appZoom);
    if (saved && 'lastStartMs' in saved) prefs.lastStartMs = startTime(saved.lastStartMs);
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
      if ('appZoom' in patch) next.appZoom = cleanZoom(patch.appZoom);
      if ('lastStartMs' in patch) next.lastStartMs = startTime(patch.lastStartMs);
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

/**
 * The executable a Run entry named `name` starts, from `reg query` output; undefined when there is no such entry or
 * its path cannot be read reliably (reg.exe prints characters outside its console code page as "?").
 */
function runEntryProgram(output, name) {
  const pattern = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\s*$`, 'im');
  const command = String(output).match(pattern)?.[1];
  if (!command) return undefined;
  const program = command.startsWith('"') ? command.slice(1, command.indexOf('"', 1)) : command.split(/\s+/)[0];
  return program && /^[\x20-\x7e]+$/.test(program) && !program.includes('?') ? program : undefined;
}

/**
 * Start at sign-in that the user turned on, rewritten for this executable when its Run entry names one that no longer
 * exists: Windows keeps the path the entry was written with, so a build that moved the app (builds used to live in
 * dated release folders) left an entry that started nothing while the setting showed as off. Packaged app only.
 */
function repairLoginItem(app, { log = () => {}, exists, readRunEntry } = {}) {
  const item = loginItem(app);
  if (!app.isPackaged || app.getLoginItemSettings(item).openAtLogin) return Promise.resolve(false);
  const name = 'MyHarness';
  const read = readRunEntry || ((value) => new Promise((resolve) => {
    require('node:child_process').execFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', value], { encoding: 'latin1', windowsHide: true, timeout: 5000 }, (error, stdout) => resolve(error ? '' : stdout));
  }));
  const fileExists = exists || require('node:fs').existsSync;
  return read(name).then((output) => {
    const program = runEntryProgram(output, name);
    if (!program || fileExists(program)) return false;
    app.setLoginItemSettings({ openAtLogin: true, ...item });
    log(`开机启动项指向已不存在的 ${program}，已改为当前程序`);
    return true;
  }, () => false);
}

module.exports = { createAppPrefs, loginItem, runEntryProgram, repairLoginItem, CLOSE_ACTIONS };
