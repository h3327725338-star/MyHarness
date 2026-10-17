// Before the Web UI kept its appearance preferences on the server, the desktop window kept them only in the
// localStorage of its origin, and the origin changed on every start (random port). This reads the newest copy those
// earlier windows left in this profile, so it can be moved to the shared copy once. Read-only; Chromium keeps
// localStorage in LevelDB, and the copies are in its write-ahead log (*.log): records in 32 KiB blocks, each a
// write batch of put/delete entries. Compacted tables (*.ldb) are not read; their copies are older than the log's.
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const KEY = /^_http:\/\/(127\.0\.0\.1:\d+)\x00\x01myharness\.web\.prefs$/;
// What a new window saved before the user changed anything (web/js/store.js). Every start began from these, so a
// value equal to them in a window's first copy is not a choice the user made.
const DEFAULTS = { shortcuts: {}, sidebarOpen: true, sidebarW: 272, panelTab: 'changes', panelW: 560, expanded: {}, expandedGeneral: {}, chatMode: 'coding', theme: 'system', colorThemes: { coding: 'classic', general: 'classic' }, motion: 'system', processDefault: 'collapsed', runMode: 'followUp', readWidth: 'auto', notify: false, lang: 'en', termShell: '' };
const varint = (buffer, at) => {
  let value = 0, shift = 0, byte;
  do { byte = buffer[at.i++]; value += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  return value;
};
// localStorage values carry a format byte: 0 = UTF-16LE, 1 = Latin-1.
const text = (value) => value[0] === 0 ? value.subarray(1).toString('utf16le') : value.subarray(1).toString('latin1');

function* batches(buffer) {
  let pending = [];
  for (let block = 0; block < buffer.length; block += 32768) {
    let at = block;
    while (at + 7 <= Math.min(block + 32768, buffer.length)) {
      const length = buffer.readUInt16LE(at + 4), type = buffer[at + 6];
      if (type === 0 && length === 0) break;
      const data = buffer.subarray(at + 7, at + 7 + length);
      at += 7 + length;
      if (type === 1) yield data;
      else if (type === 2) pending = [data];
      else if (type === 3) pending.push(data);
      else if (type === 4) { pending.push(data); yield Buffer.concat(pending); pending = []; }
    }
  }
}

/**
 * The user's choices across all earlier windows: for each preference the value of its last change. A later window's
 * copy restarted from the defaults, so the newest copy alone would lose them. `{ prefs, updatedAt }` (time of the
 * log file), `{ unreadable: true }` when copies exist but none can be read, or null when there are none.
 */
exports.readLegacyPrefs = (profileDir) => {
  const dir = join(profileDir, 'Local Storage', 'leveldb');
  let files;
  try { files = readdirSync(dir).filter((name) => /^\d+\.log$/.test(name)).sort(); } catch { return null; }
  const previous = new Map(), chosen = {};
  let latestAt = 0, found = false, read = false;
  for (const name of files) {
    let buffer;
    try { buffer = readFileSync(join(dir, name)); } catch { found = true; continue; }
    for (const batch of batches(buffer)) {
      try {
        const at = { i: 12 };
        const count = batch.readUInt32LE(8);
        for (let n = 0; n < count; n++) {
          const tag = batch[at.i++];
          const keyLength = varint(batch, at); const key = batch.subarray(at.i, at.i + keyLength).toString('latin1'); at.i += keyLength;
          if (tag !== 1) continue;
          const valueLength = varint(batch, at); const value = batch.subarray(at.i, at.i + valueLength); at.i += valueLength;
          const origin = KEY.exec(key)?.[1];
          if (!origin) continue;
          found = true;
          let prefs;
          try { prefs = JSON.parse(text(value)); } catch { continue; }
          if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) continue;
          const before = previous.get(origin) ?? DEFAULTS;
          for (const [pref, current] of Object.entries(prefs)) {
            if (JSON.stringify(current) !== JSON.stringify(before[pref])) chosen[pref] = current;
          }
          previous.set(origin, prefs);
          read = true;
          latestAt = statSync(join(dir, name)).mtimeMs;
        }
      } catch { found = true; }
    }
  }
  if (!read) return found ? { unreadable: true } : null;
  return { prefs: { ...DEFAULTS, ...chosen }, updatedAt: Math.round(latestAt) };
};
