const fs = require('node:fs');
const path = require('node:path');

const MAX_DECISIONS = 2000;

/** Replace the file in one step, so a crash leaves either the old list or the new one, never half of it. */
const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
};

/**
 * Site permission decisions of the built-in browser, keyed `origin\0permission` (see browser-view.cjs). A site is asked
 * once per permission: the answer is kept in one JSON file of the desktop host's user-data folder (outside the Data root;
 * browser sync carries it, browser-sync.cjs) and lasts until the user revokes it in the site-permission bubble. Without a file the decisions
 * last for this app run only. It has the read/write surface of a Map, and every change is written at once.
 */
exports.createPermissionStore = (file, log = () => {}) => {
  const decisions = new Map();
  const read = () => {
    decisions.clear();
    if (!file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const entry of Array.isArray(parsed?.permissions) ? parsed.permissions.slice(0, MAX_DECISIONS) : []) {
        if (typeof entry?.origin !== 'string' || typeof entry?.permission !== 'string' || typeof entry?.allowed !== 'boolean') continue;
        decisions.set(`${entry.origin}\0${entry.permission}`, entry.allowed);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`网站权限记录无法读取，本次从空记录开始：${error.message}`);
    }
  };
  read();
  const save = () => {
    if (!file) return;
    const permissions = [...decisions].slice(-MAX_DECISIONS).map(([key, allowed]) => {
      const separator = key.indexOf('\0');
      return { origin: key.slice(0, separator), permission: key.slice(separator + 1), allowed };
    });
    try { writeAtomic(file, `${JSON.stringify({ version: 1, permissions }, null, 2)}\n`); } catch (error) { log(`网站权限记录保存失败：${error.message}`); }
  };
  return {
    get: (key) => decisions.get(key),
    /** Read the file again (browser sync wrote it, browser-sync.cjs). */
    reload: read,
    set(key, allowed) {
      if (decisions.get(key) === allowed) return this;
      decisions.delete(key);
      decisions.set(key, allowed);
      save();
      return this;
    },
    delete(key) {
      const removed = decisions.delete(key);
      if (removed) save();
      return removed;
    },
    [Symbol.iterator]: () => decisions[Symbol.iterator](),
  };
};
