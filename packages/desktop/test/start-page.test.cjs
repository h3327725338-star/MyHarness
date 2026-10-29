const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SHELL_COLORS, cannotStartPage, shellColors, shellMotion, startWait, startingPage } = require('../start-page.cjs');

const english = (en) => en;
const chinese = (_en, zh) => zh;

test('the host pages take the colors of the saved appearance, decided as the app page decides them', () => {
  // Nothing saved yet: the app follows Windows, and so do these pages.
  assert.equal(shellColors(null, true), SHELL_COLORS.classic);
  assert.equal(shellColors(null, false), SHELL_COLORS.light);
  assert.equal(shellColors({ theme: 'light' }, true), SHELL_COLORS.light);
  assert.equal(shellColors({ theme: 'dark' }, false), SHELL_COLORS.classic);
  // Each mode has its own color theme; the old single setting still counts.
  assert.equal(shellColors({ theme: 'dark', chatMode: 'general', colorThemes: { coding: 'amber', general: 'forest' } }, false), SHELL_COLORS.forest);
  assert.equal(shellColors({ theme: 'dark', colorThemes: { coding: 'amber' } }, false), SHELL_COLORS.amber);
  assert.equal(shellColors({ theme: 'system', colorTheme: 'forest' }, true), SHELL_COLORS.forest);
  assert.equal(shellColors({ theme: 'dark', colorTheme: 'neon' }, false), SHELL_COLORS.classic);
  assert.equal(shellMotion({ motion: 'off' }), 'off');
  assert.equal(shellMotion({ motion: 'on' }), 'on');
  assert.equal(shellMotion({}), 'system');
  assert.equal(shellMotion(null), 'system');
});

test('the starting page says about how long the wait is, and nothing when starting is quick', () => {
  const first = startWait(undefined, english);
  assert.equal(first.hint, 'The first start takes about 20 seconds.');
  assert.equal(first.expectMs, 20000);
  assert.ok(first.laterMs > first.expectMs);
  assert.equal(startWait(null, chinese).hint, '第一次启动大约需要 20 秒。');
  // Later starts: the last start's time, rounded up to five seconds.
  assert.equal(startWait(17300, english).hint, 'Usually takes about 20 seconds.');
  assert.equal(startWait(11000, chinese).hint, '通常需要约 15 秒。');
  assert.equal(startWait(17300, english).expectMs, 17300);
  // A quick start needs no hint, but a start that takes clearly longer than expected still gets the calm note.
  const quick = startWait(3000, english);
  assert.equal(quick.hint, '');
  assert.equal(quick.laterMs, 13000);
  assert.match(quick.later, /longer than usual/);
  assert.equal(startWait(30000, english).laterMs, 48000);
  assert.equal(startWait(NaN, english).expectMs, 20000);
});

test('the starting page is a complete page in the interface language with the window buttons', () => {
  const html = startingPage({ lang: 'zh-CN', colors: SHELL_COLORS.light, motion: 'system', say: chinese, startedAt: 1000, lastMs: 16000 });
  assert.match(html, /^<!doctype html><html lang="zh-CN">/);
  assert.match(html, /<h1>MyHarness<\/h1>/);
  assert.match(html, /正在启动…/);
  assert.match(html, /通常需要约 20 秒。/);
  assert.match(html, /color-scheme:light;--bg:#fbfbfa/);
  for (const id of ['wc-min', 'wc-max', 'wc-close']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /aria-label="最小化"/);
  // The note for a long wait is in the page's script, in the same language, and never ends the script early.
  assert.match(html, /比平时久一点，还在启动…/);
  assert.doesNotMatch(html.slice(html.indexOf('<script>{const started')), /<\/script>.*<\/script>/s);
});

test('the cannot-start page shows the reason as text, never as markup', () => {
  const html = cannotStartPage({ lang: 'en', colors: SHELL_COLORS.classic, motion: 'off', say: english, message: 'port <in use> & "busy"', logs: 'C:\\data\\logs' });
  assert.match(html, /MyHarness cannot start/);
  assert.match(html, /port &lt;in use&gt; &amp; &quot;busy&quot;/);
  assert.match(html, /Logs: C:\\data\\logs/);
  assert.doesNotMatch(html, /<in use>/);
});
