const fs = require('node:fs');
const path = require('node:path');

const MAX_DOWNLOADS = 50;
const STATES = new Set(['completed', 'failed', 'cancelled']);

/** Replace the file in one step, so a crash leaves either the old list or the new one, never half of it. */
const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
};

/** What is kept of a finished download. The tab it came from is not: after a restart that tab is gone. */
const keep = (entry) => ({
  id: entry.id,
  seq: Number(entry.seq) || 0,
  name: entry.name,
  savePath: entry.savePath,
  url: typeof entry.url === 'string' ? entry.url : '',
  total: Number(entry.total) || 0,
  received: Number(entry.received) || 0,
  state: entry.state,
  ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
  at: Number(entry.at) || 0,
});

/**
 * Finished downloads of the built-in browser (completed, failed or cancelled), oldest first, at most MAX_DOWNLOADS. They
 * are kept in one JSON file of the desktop host's user-data folder, so the downloads list of the browser toolbar still
 * shows them after a restart; without a file they last for this app run only. `records` is the live array that
 * browser-view.cjs adds to and trims; `save()` writes it after each change.
 */
exports.createDownloadHistory = (file, log = () => {}) => {
  const records = [];
  if (file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const entry of Array.isArray(parsed?.downloads) ? parsed.downloads.slice(-MAX_DOWNLOADS) : []) {
        if (typeof entry?.id !== 'string' || typeof entry?.name !== 'string' || typeof entry?.savePath !== 'string' || !STATES.has(entry.state)) continue;
        records.push(keep(entry));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`下载记录无法读取，本次从空记录开始：${error.message}`);
    }
  }
  const save = () => {
    while (records.length > MAX_DOWNLOADS) records.shift();
    if (!file) return;
    const downloads = records.filter((entry) => STATES.has(entry.state)).map(keep);
    try { writeAtomic(file, `${JSON.stringify({ version: 1, downloads }, null, 2)}\n`); } catch (error) { log(`下载记录保存失败：${error.message}`); }
  };
  return { records, save };
};
