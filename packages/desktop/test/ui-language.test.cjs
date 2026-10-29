const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUiLanguage, readUiPrefs, systemUiLanguage, translator, UI_PREFS_FILE } = require('../ui-language.cjs');

test('only a Simplified Chinese Windows starts in Chinese; every other language starts in English', () => {
  for (const tag of ['zh-Hans-CN', 'zh-CN', 'zh-cn', 'zh', 'zh-Hans', 'zh-SG', 'zh-MY', 'zh-Hans-HK']) assert.equal(systemUiLanguage([tag, 'en-US']), 'zh-CN', tag);
  for (const tag of ['zh-Hant-TW', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'en-US', 'en-GB', 'ja-JP', 'ms-MY', '', undefined]) assert.equal(systemUiLanguage([tag, 'zh-Hans-CN']), 'en', String(tag));
  // The first language is the one Windows shows: Chinese listed second does not count.
  assert.equal(systemUiLanguage(['en-US', 'zh-Hans-CN']), 'en');
  assert.equal(systemUiLanguage([]), 'en');
  assert.equal(systemUiLanguage(undefined), 'en');
});

test('until the user picks a language the host follows Windows, and the saved choice wins once there is one', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-ui-language-'));
  try {
    let windows = 'zh-CN';
    const uiLanguage = createUiLanguage(agentDir, () => windows);
    assert.equal(uiLanguage(), 'zh-CN');
    windows = 'en';
    assert.equal(uiLanguage(), 'en');
    const file = path.join(agentDir, UI_PREFS_FILE);
    // Preferences without a language (only other settings saved yet) still follow Windows.
    fs.writeFileSync(file, JSON.stringify({ prefs: { theme: 'light' }, updatedAt: 1 }));
    windows = 'zh-CN';
    assert.equal(uiLanguage(), 'zh-CN');
    assert.deepEqual(readUiPrefs(agentDir), { theme: 'light' });
    fs.writeFileSync(file, JSON.stringify({ prefs: { theme: 'light', lang: 'en' }, updatedAt: 2 }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(uiLanguage(), 'en');
    // Unreadable preferences are none saved: Windows again, as on the page.
    fs.writeFileSync(file, '{ not json');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
    assert.equal(uiLanguage(), 'zh-CN');
    assert.equal(readUiPrefs(agentDir), null);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('the host speaks the interface language the page saved, English without one', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-ui-language-'));
  try {
    const uiLanguage = createUiLanguage(agentDir);
    const say = translator(uiLanguage);
    // A new user: no preferences file yet, like the page's own default.
    assert.equal(uiLanguage(), 'en');
    assert.equal(say('Starting MyHarness…', '正在启动 MyHarness…'), 'Starting MyHarness…');
    const file = path.join(agentDir, UI_PREFS_FILE);
    fs.writeFileSync(file, JSON.stringify({ prefs: { lang: 'zh-CN' }, updatedAt: 1 }));
    assert.equal(uiLanguage(), 'zh-CN');
    assert.equal(say('Starting MyHarness…', '正在启动 MyHarness…'), '正在启动 MyHarness…');
    // A change is seen on the next question (the file's time moved).
    fs.writeFileSync(file, JSON.stringify({ prefs: { lang: 'en' }, updatedAt: 2 }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(uiLanguage(), 'en');
    // A file that cannot be read is English, not an error.
    fs.writeFileSync(file, '{ not json');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
    assert.equal(uiLanguage(), 'en');
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('without a language source the host speaks English', () => {
  assert.equal(translator(undefined)('Close', '关闭'), 'Close');
});
