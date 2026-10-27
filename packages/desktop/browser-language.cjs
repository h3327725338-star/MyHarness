// Language of the built-in browser: what websites are told the user reads (the Accept-Language header and
// navigator.language / navigator.languages), so a site that picks its language from the browser shows that one.
// '' leaves the engine's own default (the language of Windows). Kept in browser-language.json of the desktop profile.
const { readFileSync, writeFileSync, renameSync, existsSync } = require('node:fs');

/** The choices offered in the browser toolbar, as BCP 47 tags. */
const BROWSER_LANGUAGES = ['zh-CN', 'zh-TW', 'en-US', 'en-GB', 'ja', 'ko', 'fr', 'de', 'es', 'ru'];

/** navigator.languages for `tag`: the tag, its base language, then English as the usual last resort. */
function languageList(tag) {
  if (!BROWSER_LANGUAGES.includes(tag)) return [];
  const base = tag.split('-')[0];
  const list = [tag];
  if (base !== tag) list.push(base);
  if (base !== 'en') list.push('en-US', 'en');
  return list;
}

/** The Accept-Language header a Chrome with these languages sends: the first as it is, the rest with falling weights. */
function acceptLanguage(tag) {
  const list = languageList(tag);
  return list.map((item, index) => (index === 0 ? item : `${item};q=${Math.max(0.1, 1 - index / 10).toFixed(1)}`)).join(',');
}

function createLanguageStore(file, log = () => undefined) {
  const read = () => {
    try {
      if (file && existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (BROWSER_LANGUAGES.includes(saved?.language)) return saved.language;
      }
    } catch (error) {
      log(`读取浏览器语言失败：${error.message}`);
    }
    return '';
  };
  let language = read();
  return {
    get: () => language,
    /** Read the file again (browser sync wrote it, browser-sync.cjs). */
    reload() { language = read(); return language; },
    set(value) {
      const next = BROWSER_LANGUAGES.includes(value) ? value : '';
      if (next === language) return language;
      language = next;
      if (file) {
        try {
          const temp = `${file}.tmp`;
          writeFileSync(temp, JSON.stringify({ version: 1, language }, null, 2));
          renameSync(temp, file);
        } catch (error) {
          log(`保存浏览器语言失败：${error.message}`);
        }
      }
      return language;
    },
  };
}

/**
 * The saved website language also becomes the engine's own language (Chromium's --lang), for the parts of a site that
 * only read that one: a frame of another site and a page's workers. It has to be set before the app is ready, so a
 * change in the toolbar reaches them after the next start. Returns the language applied ('' : the engine's default).
 */
function applyEngineLanguage(app, file) {
  const language = createLanguageStore(file).get();
  if (language) app.commandLine.appendSwitch('lang', language);
  return language;
}

module.exports = { BROWSER_LANGUAGES, languageList, acceptLanguage, createLanguageStore, applyEngineLanguage };
