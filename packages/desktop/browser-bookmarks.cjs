const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BOOKMARKS = 500;
const MAX_TITLE = 200;
// What the site is for, in the user's words or written by the app when the page was bookmarked; the Agent reads it in
// every chat (packages/coding-agent/src/tools/workspace-bookmarks.ts), so it stays one or two sentences.
const MAX_NOTE = 500;
// A site icon is kept inline so the bar shows it offline and after a restart; anything larger is dropped (letter fallback).
const MAX_ICON_CHARS = 96 * 1024;
const ICON_PATTERN = /^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/;

const webUrl = (value) => {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('书签只能保存 http 或 https 网页地址');
  return url.href;
};

const cleanTitle = (value, url) => {
  const title = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (title) return title;
  try { return new URL(url).hostname; } catch { return url; }
};

const cleanNote = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);

// Who wrote a note the app wrote: the model of Settings → Assistants → Bookmark notes ("provider/model"), or "agent"
// for the Agent filling it in while it worked on a task. Shown in the bookmark editor and list.
const cleanBy = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 120) : '');

const cleanIcon = (value) => (typeof value === 'string' && value.length <= MAX_ICON_CHARS && ICON_PATTERN.test(value) ? value : undefined);

/** Normalize one stored record; anything unusable is dropped instead of breaking the whole bar. */
const cleanRecord = (value) => {
  if (!value || typeof value !== 'object') return null;
  let url;
  try { url = webUrl(value.url); } catch { return null; }
  const record = {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, 64) : randomUUID(),
    title: cleanTitle(value.title, url),
    url,
    addedAt: typeof value.addedAt === 'string' ? value.addedAt : new Date().toISOString(),
  };
  const icon = cleanIcon(value.icon);
  if (icon) record.icon = icon;
  const note = cleanNote(value.note);
  if (note) record.note = note;
  // The app wrote the note (not the user): a later page of the site, or the Agent, may write a better one.
  if (note && value.noteAuto === true) {
    record.noteAuto = true;
    const by = cleanBy(value.noteBy);
    if (by) record.noteBy = by;
  }
  if (typeof value.updatedAt === 'string') record.updatedAt = value.updatedAt;
  if (typeof value.lastUsedAt === 'string') record.lastUsedAt = value.lastUsedAt;
  return record;
};

/** Replace the file in one step, so a crash leaves either the old list or the new one, never half of it. */
const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
};

/**
 * Bookmarks of the built-in browser: one JSON file in the desktop host's user-data folder, outside the Data root (Drive
 * sync carries this file as it is, browser-sync.cjs). Unknown fields of a newer version are ignored; a damaged file is set aside as
 * `.damaged` before the next write instead of being overwritten silently.
 */
exports.createBookmarkStore = (file) => {
  let cache = null;
  let damaged = false;
  const load = () => {
    if (cache) return cache;
    cache = [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return cache; }
    try {
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed?.bookmarks) ? parsed.bookmarks : [];
      cache = items.map(cleanRecord).filter(Boolean).slice(0, MAX_BOOKMARKS);
    } catch {
      damaged = true;
    }
    return cache;
  };
  const save = (items) => {
    if (damaged) {
      try { fs.copyFileSync(file, `${file}.damaged`); } catch { /* nothing to keep */ }
      damaged = false;
    }
    writeAtomic(file, `${JSON.stringify({ version: 1, bookmarks: items }, null, 2)}\n`);
    cache = items;
    return list();
  };
  const list = () => load().map((item) => ({ ...item }));
  const find = (id) => {
    const item = load().find((entry) => entry.id === id);
    if (!item) throw new Error('这个书签已不存在');
    return item;
  };
  return {
    list,
    /** Read the file again on the next use (browser sync wrote it, browser-sync.cjs). */
    reload() { cache = null; damaged = false; },
    add({ url, title, icon, note, noteAuto, noteBy }) {
      const href = webUrl(url);
      const items = load();
      if (items.length >= MAX_BOOKMARKS) throw new Error(`书签最多 ${MAX_BOOKMARKS} 个`);
      const now = new Date().toISOString();
      const record = { id: randomUUID(), title: cleanTitle(title, href), url: href, addedAt: now, updatedAt: now };
      const cleaned = cleanIcon(icon);
      if (cleaned) record.icon = cleaned;
      const text = cleanNote(note);
      if (text) record.note = text;
      if (text && noteAuto === true) {
        record.noteAuto = true;
        if (cleanBy(noteBy)) record.noteBy = cleanBy(noteBy);
      }
      return save([...items, record]);
    },
    update(id, { url, title, note, noteAuto, noteBy }) {
      const current = find(id);
      const href = url === undefined ? current.url : webUrl(url);
      const next = { ...current, url: href, title: cleanTitle(title === undefined ? current.title : title, href), updatedAt: new Date().toISOString() };
      // A bookmark moved to another site keeps no icon of the old one.
      if (new URL(href).origin !== new URL(current.url).origin) delete next.icon;
      if (note !== undefined) {
        const text = cleanNote(note);
        if (text) next.note = text;
        else delete next.note;
        delete next.noteBy;
        if (text && noteAuto === true) {
          next.noteAuto = true;
          if (cleanBy(noteBy)) next.noteBy = cleanBy(noteBy);
        } else delete next.noteAuto;
      }
      return save(load().map((entry) => (entry.id === id ? next : entry)));
    },
    /**
     * Only the note, written by the app (`by`: the model, or "agent"). `keepUsers`: a note the user wrote stays (the
     * Agent improving notes while it works never replaces the user's words).
     */
    setNote(id, { note, by, keepUsers = false }) {
      const current = find(id);
      const text = cleanNote(note);
      if (!text) throw new Error('用途不能为空');
      if (keepUsers && current.note && current.noteAuto !== true) throw new Error('这个书签的用途是用户自己写的，不要改它；用户要求改时由用户在书签里编辑');
      const next = { ...current, note: text, noteAuto: true, updatedAt: new Date().toISOString() };
      delete next.noteBy;
      if (cleanBy(by)) next.noteBy = cleanBy(by);
      return save(load().map((entry) => (entry.id === id ? next : entry)));
    },
    /** The Agent or the user opened this bookmark: the most recently used ones lead the Agent's list when it is long. */
    used(id) {
      const current = load().find((entry) => entry.id === id);
      if (!current) return list();
      // An hour is fine enough for an order, and the file (which sync carries) is not rewritten on every use.
      if (current.lastUsedAt && Date.now() - Date.parse(current.lastUsedAt) < 60 * 60 * 1000) return list();
      const next = { ...current, lastUsedAt: new Date().toISOString() };
      return save(load().map((entry) => (entry.id === id ? next : entry)));
    },
    remove(id) {
      find(id);
      return save(load().filter((entry) => entry.id !== id));
    },
  };
};
