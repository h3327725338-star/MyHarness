const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_SITES = 200;
const MAX_TITLE = 80;
const SEED_COUNT = 12;
// A shortcut keeps its site icon inline so the page shows it offline and after a restart; anything larger is dropped.
const MAX_ICON_CHARS = 96 * 1024;
const ICON_PATTERN = /^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/;

const webUrl = (value) => {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('快捷方式只能保存 http 或 https 网页地址');
  return url.href;
};

const cleanTitle = (value, fallback) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || fallback;
const cleanId = (value) => (typeof value === 'string' && /^[\w-]{1,64}$/.test(value) ? value : randomUUID());

const cleanSite = (value) => {
  if (!value || typeof value !== 'object') return null;
  let url;
  try { url = webUrl(value.url); } catch { return null; }
  // A shortcut without a name is shown as its icon alone (the page names it by its host in the tooltip).
  const site = { id: cleanId(value.id), type: 'site', title: cleanTitle(value.title, ''), url };
  if (typeof value.icon === 'string' && value.icon.length <= MAX_ICON_CHARS && ICON_PATTERN.test(value.icon)) site.icon = value.icon;
  // The icon was looked for and the site has none: the letter is shown and nobody asks again.
  else if (value.noIcon === true) site.noIcon = true;
  return site;
};

/**
 * The layout of the new-tab page: shortcuts and groups of shortcuts, in the user's order. Groups hold sites only (one
 * level, like the Start menu's folders); a group left with no site disappears, and ids are unique across the layout.
 */
const cleanLayout = (value) => {
  const items = [];
  const seen = new Set();
  let sites = 0;
  const unique = (entry) => {
    if (seen.has(entry.id)) entry.id = randomUUID();
    seen.add(entry.id);
    return entry;
  };
  for (const raw of Array.isArray(value) ? value : []) {
    if (sites >= MAX_SITES) break;
    if (raw?.type === 'group') {
      const children = [];
      for (const child of Array.isArray(raw.items) ? raw.items : []) {
        if (sites >= MAX_SITES) break;
        const site = cleanSite(child);
        if (!site) continue;
        children.push(unique(site));
        sites += 1;
      }
      if (!children.length) continue;
      items.push(unique({ id: cleanId(raw.id), type: 'group', title: cleanTitle(raw.title, ''), items: children }));
      continue;
    }
    const site = cleanSite(raw);
    if (!site) continue;
    items.push(unique(site));
    sites += 1;
  }
  return items;
};

const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
};

/**
 * Shortcuts of the built-in browser's new-tab page, one JSON file in the desktop host's user-data folder (next to the
 * bookmarks, outside the Data root). Before the user arranges anything the page shows the first bookmarks; nothing is
 * written until the first change. A damaged file is set aside as `.damaged` before the next write.
 */
exports.createSpeedDialStore = (file, { seed } = {}) => {
  let cache = null;
  let damaged = false;
  const load = () => {
    if (cache) return cache;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      const bookmarks = typeof seed === 'function' ? seed() : [];
      cache = cleanLayout((Array.isArray(bookmarks) ? bookmarks : []).slice(0, SEED_COUNT).map((item) => ({ title: item.title, url: item.url, icon: item.icon })));
      return cache;
    }
    try {
      cache = cleanLayout(JSON.parse(text)?.items);
    } catch {
      damaged = true;
      cache = [];
    }
    return cache;
  };
  const persist = (items) => {
    if (damaged) {
      try { fs.copyFileSync(file, `${file}.damaged`); } catch { /* nothing to keep */ }
      damaged = false;
    }
    writeAtomic(file, `${JSON.stringify({ version: 1, items }, null, 2)}\n`);
    cache = items;
  };
  const sitesOf = (items) => items.flatMap((item) => (item.type === 'group' ? item.items : [item]));
  const copy = (items) => items.map((item) => (item.type === 'group' ? { ...item, items: item.items.map((site) => ({ ...site })) } : { ...item }));
  return {
    list: () => copy(load()),
    /** Read the file again on the next use (browser sync wrote it, browser-sync.cjs). */
    reload() { cache = null; damaged = false; },
    /** Replace the whole layout (the page sends what the user arranged) and return the cleaned version. */
    save(items) {
      const next = cleanLayout(items);
      persist(next);
      return copy(next);
    },
    /** Sites that have neither an icon nor a finished attempt to find one. */
    missingIcons: () => sitesOf(load()).filter((site) => !site.icon && !site.noIcon).map((site) => ({ id: site.id, url: site.url })),
    /** Store a found icon, or `null` to remember that the site has none; true when something changed. */
    setIcon(id, icon) {
      const site = sitesOf(load()).find((entry) => entry.id === id);
      if (!site) return false;
      if (typeof icon === 'string' && icon.length <= MAX_ICON_CHARS && ICON_PATTERN.test(icon)) {
        site.icon = icon;
        delete site.noIcon;
      } else {
        site.noIcon = true;
      }
      persist(cache);
      return true;
    },
  };
};
