// One email sent through the Gmail or Outlook website the built-in browser is signed in to, with no person and no model
// working the page: the website's own compose address opens the message already filled in (recipients, subject, text)
// in a page of the tabs' session that is never shown, and its Send button is pressed. A scheduled email goes out on
// time this way, and the Agent's `mail` tool can send without an API mailbox. The Agent filling the compose form field
// by field took minutes: the focus moved between fields and text landed in the wrong one.
//
// The page is the caller's (`contents`, a webContents); this module loads the compose address into it, waits until the
// form shows the message, presses Send (a real mouse click, then Ctrl+Enter, then a scripted click) and waits for the
// website to report the message sent. Each failure names where it stopped: not signed in, a recipient or subject the
// form does not show, a complaint of the website (an address it does not know), no Send button, no answer.
const { keyEvents } = require(require('node:path').join(__dirname, 'browser-input.cjs'));

const PROVIDERS = ['google', 'microsoft'];
const NAMES = { google: 'Gmail', microsoft: 'Outlook' };
const PERSONAL_OUTLOOK = /@(?:outlook|hotmail|live|msn|passport)\.[a-z.]+$/i;
const ADDRESS = /[^\s<>"',;]+@[^\s<>"',;]+\.[^\s<>"',;]+/;

/** The bare address of "Name <address>" or of an address. */
const bareAddress = (value) => (ADDRESS.exec(String(value || '')) || [''])[0].toLowerCase();

/**
 * The website's compose address for a message: Gmail's full-window compose (`view=cm`), or Outlook's compose deep link
 * (outlook.live.com for personal accounts, outlook.office.com for work and school ones). `account` picks the Gmail
 * account when several are signed in; for Outlook it tells personal from work.
 */
function composeAddress(provider, message, { account } = {}) {
  const list = (values) => (Array.isArray(values) ? values.map(String).filter(Boolean).join(',') : '');
  const params = new URLSearchParams();
  const add = (key, value) => { if (value) params.set(key, value); };
  if (provider === 'google') {
    params.set('view', 'cm');
    params.set('fs', '1');
    params.set('tf', '1');
    add('to', list(message.to));
    add('cc', list(message.cc));
    add('bcc', list(message.bcc));
    add('su', String(message.subject || ''));
    add('body', String(message.text || ''));
    if (account && ADDRESS.test(account)) params.set('authuser', bareAddress(account));
    return `https://mail.google.com/mail/?${params}`;
  }
  if (provider === 'microsoft') {
    add('to', list(message.to));
    add('cc', list(message.cc));
    add('bcc', list(message.bcc));
    add('subject', String(message.subject || ''));
    add('body', String(message.text || ''));
    const work = account && ADDRESS.test(account) && !PERSONAL_OUTLOOK.test(bareAddress(account));
    return work ? `https://outlook.office.com/mail/deeplink/compose?${params}` : `https://outlook.live.com/mail/0/deeplink/compose?${params}`;
  }
  throw new Error(`未知的邮箱网站：${provider}`);
}

/**
 * In the page: where the compose form is. `{ state: 'signIn' | 'loading' | 'ready' | 'sent' | 'error', … }`; when ready,
 * what the form shows against what was asked (`missing`: the recipients, subject or text not in it) and the Send
 * button's middle (`send`, page CSS pixels, after scrolling it into view). Gmail's "View message" link (`#link_vsm`) is
 * its own word that the message went; a form that closed without a complaint counts too once Send was pressed.
 */
function composeState(arg) {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const textOf = (el) => (el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const host = location.hostname;
  if (/^(accounts\.google\.com|login\.live\.com|login\.microsoftonline\.com|login\.microsoft\.com)$/.test(host) || document.querySelector('input[type="password"]')) return { state: 'signIn', url: location.href };
  const complaint = [...document.querySelectorAll('[role="alertdialog"]')].find(visible);
  if (complaint) return { state: 'error', error: textOf(complaint).slice(0, 300) };
  const google = arg.provider === 'google';
  if (google && document.querySelector('#link_vsm')) return { state: 'sent' };
  const subject = google
    ? document.querySelector('input[name="subjectbox"]')
    : [...document.querySelectorAll('input')].find((el) => visible(el) && /subject|主题|主旨|件名|betreff|objet|asunto|oggetto/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`));
  const body = google
    ? document.querySelector('div[g_editable="true"][contenteditable="true"]') || document.querySelector('div[contenteditable="true"][role="textbox"]')
    : [...document.querySelectorAll('div[contenteditable="true"]')].find(visible);
  if (!body && !subject) return { state: arg.pressed ? 'closed' : 'loading', url: location.href };
  if (!body || !visible(body)) return { state: 'loading', url: location.href };
  // The smallest part of the page that holds the subject and the text: the form, not the mailbox around it. The Send
  // button and the recipients may sit in a row outside that part; a compose page shows one form, so the whole page is
  // looked at for them next.
  let root = body;
  while (subject && root.parentElement && !root.contains(subject)) root = root.parentElement;
  const labelOf = (el) => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip') || ''} ${el.getAttribute('title') || ''}`;
  const findSend = (scope) => {
    const buttons = [...scope.querySelectorAll(google ? '[role="button"]' : 'button, [role="button"]')].filter(visible);
    return buttons.find((el) => /(?:ctrl|⌘|command)\s*[-+]?\s*enter/i.test(labelOf(el)))
      || (google ? scope.querySelector('[role="button"].aoO') : buttons.find((el) => /^\s*(send|发送|傳送|送信|enviar|envoyer|senden|invia)\b/i.test(labelOf(el)) || /^(send|发送|傳送|送信)$/i.test(textOf(el)) || /send/i.test(el.getAttribute('data-testid') || '')));
  };
  const send = findSend(root) || findSend(document);
  // What the form shows: Gmail turns each recipient into a chip carrying its address; Outlook shows names, so there the
  // text that holds the recipients is searched for each address or the name before it.
  const shown = new Set();
  const chips = (scope) => scope.querySelectorAll('[email], [data-hovercard-id]');
  for (const el of chips(root).length ? chips(root) : chips(document)) {
    const value = (el.getAttribute('email') || el.getAttribute('data-hovercard-id') || '').toLowerCase();
    if (value.includes('@')) shown.add(value);
  }
  const rootText = textOf(root).toLowerCase();
  const missing = [];
  for (const address of arg.recipients) {
    if (shown.has(address)) continue;
    if (!google && rootText.includes(address)) continue;
    if (!google && !shown.size) continue;
    missing.push(address);
  }
  if (arg.subject && subject && subject.value.trim() !== arg.subject.trim()) missing.push('subject');
  // The text as written: Gmail draws each emoji as a picture (`<img data-emoji alt>`), which innerText leaves out, so a
  // message of "🙂" looked empty. Spaces, line breaks and emoji variation marks are left out on both sides, since each
  // website lays the text out its own way.
  let written = '';
  const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) written += node.data;
    else if (node.tagName === 'IMG') written += node.getAttribute('data-emoji') || node.getAttribute('alt') || '';
  }
  const bare = (value) => String(value).replace(/[\s​-‍⁠﻿︎️]+/g, '');
  if (arg.text && !bare(written).includes([...bare(arg.text)].slice(0, 40).join(''))) missing.push('text');
  const shownText = written.replace(/\s+/g, ' ').trim();
  let point = null;
  if (send) {
    send.scrollIntoView({ block: 'center', inline: 'center' });
    const box = send.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) point = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  }
  return { state: 'ready', missing, send: point, shownText: shownText.length > 60 ? `${shownText.slice(0, 60)}…` : shownText, url: location.href };
}

/** In the page: put the keyboard in the message text, so Ctrl+Enter reaches the form. */
function focusBody(arg) {
  const body = arg.provider === 'google'
    ? document.querySelector('div[g_editable="true"][contenteditable="true"]') || document.querySelector('div[contenteditable="true"][role="textbox"]')
    : document.querySelector('div[contenteditable="true"]');
  if (!body) return false;
  body.focus();
  return document.activeElement === body || body.contains(document.activeElement);
}

/** In the page: the Send button pressed by script (mouse down, up, click), for a form that missed the real click. */
function scriptedSend(arg) {
  const at = document.elementFromPoint(arg.x, arg.y);
  const button = at && (at.closest('[role="button"], button') || at);
  if (!button) return false;
  for (const type of ['mousedown', 'mouseup', 'click']) button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: arg.x, clientY: arg.y, button: 0 }));
  return true;
}

const pageCall = (fn, arg) => `(${fn})(${JSON.stringify(arg ?? null)})`;

/**
 * Send `message` ({ to, cc?, bcc?, subject, text }) through `provider`'s website in `contents`. Resolves with
 * `{ ok: true, provider, ms }`; rejects with what stopped it. `timeoutMs` covers the whole send.
 */
async function sendThroughPage(contents, { provider, message, account, timeoutMs = 60000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, log = () => undefined } = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error(`未知的邮箱网站：${provider}`);
  const name = NAMES[provider];
  const recipients = [...(message.to || []), ...(message.cc || []), ...(message.bcc || [])].map(bareAddress).filter(Boolean);
  if (!(message.to || []).map(bareAddress).filter(Boolean).length) throw new Error('邮件没有收件人');
  if (!String(message.subject || '').trim()) throw new Error(`用 ${name} 网页发信需要主题`);
  const started = now();
  const deadline = started + Math.max(5000, Number(timeoutMs) || 60000);
  const expect = { provider, recipients, subject: String(message.subject || ''), text: String(message.text || '') };
  let gone = false;
  contents.once?.('destroyed', () => { gone = true; });
  const run = async (fn, arg) => {
    if (gone || contents.isDestroyed?.()) return { state: 'closed' };
    try {
      return await contents.executeJavaScript(pageCall(fn, arg), true);
    } catch (error) {
      // A page that is replacing itself (Gmail's redirects) answers nothing for a moment; one that closed is gone.
      if (gone || contents.isDestroyed?.()) return { state: 'closed' };
      log(`写信页暂时没有回应：${error.message}`);
      return { state: 'loading' };
    }
  };
  const address = composeAddress(provider, message, { account });
  await contents.loadURL(address).catch((error) => {
    // The website sending itself to its own address aborts the first load; the page it went to is the one used.
    if (!/ERR_ABORTED|\(-3\)/.test(String(error?.message))) throw new Error(`打不开 ${name} 写信页：${error.message}`);
  });
  // 1. The form, filled in. A form that is up but still lacks what was asked gets a few seconds to show it.
  let state;
  let readyAt = 0;
  for (;;) {
    state = await run(composeState, expect);
    if (state.state === 'signIn') throw new Error(`内置浏览器里的 ${name} 没有登录，请先在内置浏览器登录 ${name}`);
    if (state.state === 'error') throw new Error(`${name} 拒绝了这封邮件：${state.error}`);
    if (state.state === 'closed') throw new Error(`${name} 写信页关掉了`);
    if (state.state === 'ready') {
      readyAt ||= now();
      if (!state.missing.length && state.send) break;
      if (now() - readyAt > 5000) {
        if (!state.send) throw new Error(`${name} 写信页上找不到“发送”按钮`);
        const what = state.missing.map((item) => (item === 'subject' ? '主题' : item === 'text' ? '正文' : item));
        const shown = state.missing.includes('text') ? `（页面上的正文${state.shownText ? `是“${state.shownText}”` : '是空的'}）` : '';
        throw new Error(`${name} 写信页没有填好：${what.join('、')}${shown}；没发出的信可能留在草稿箱`);
      }
    }
    if (now() > deadline) throw new Error(`${name} 写信页 ${Math.round((now() - started) / 1000)} 秒内没有打开`);
    await sleep(250);
  }
  // Gmail draws the form before its buttons listen; a moment later a click is taken.
  await sleep(400);
  const point = state.send;
  // 2. Send: a real click on the button, then Ctrl+Enter in the text, then a scripted click, each given a few seconds.
  const debuggerApi = contents.debugger;
  let attached = false;
  const cdp = async (method, params) => {
    if (!attached && !debuggerApi.isAttached()) { debuggerApi.attach('1.3'); attached = true; }
    return debuggerApi.sendCommand(method, params);
  };
  const tries = [
    async () => {
      const mouse = (params) => cdp('Input.dispatchMouseEvent', { pointerType: 'mouse', modifiers: 0, ...params });
      await mouse({ type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
      await mouse({ type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await mouse({ type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    },
    async () => {
      await run(focusBody, { provider });
      for (const event of keyEvents('Control+Enter')) await cdp('Input.dispatchKeyEvent', event);
    },
    async () => { await run(scriptedSend, point); },
  ];
  try {
    for (const [index, press] of tries.entries()) {
      if (gone) break;
      try {
        await press();
      } catch (error) {
        log(`按“发送”的第 ${index + 1} 种方式没有成功：${error.message}`);
      }
      // 3. The website's answer: sent, a complaint, or the form still waiting (then the next way of pressing Send).
      const waitUntil = Math.min(deadline, now() + (index < tries.length - 1 ? 3000 : 15000));
      for (;;) {
        const after = gone ? { state: 'closed' } : await run(composeState, { ...expect, pressed: true });
        if (after.state === 'error') throw new Error(`${name} 没有发出这封邮件：${after.error}`);
        if (after.state === 'signIn') throw new Error(`${name} 要求重新登录，邮件没有发出`);
        if (after.state === 'sent' || after.state === 'closed') {
          // A complaint can come a moment after the form closes (an address it checked on the server).
          await sleep(gone ? 0 : 600);
          const settled = gone ? { state: 'closed' } : await run(composeState, { ...expect, pressed: true });
          if (settled.state === 'error') throw new Error(`${name} 没有发出这封邮件：${settled.error}`);
          return { ok: true, provider, ms: now() - started };
        }
        if (now() > waitUntil) break;
        await sleep(250);
      }
      if (now() > deadline) break;
    }
  } finally {
    if (attached) { try { debuggerApi.detach(); } catch { /* already gone */ } }
  }
  throw new Error(`按了“发送”，但 ${name} 在 ${Math.round((now() - started) / 1000)} 秒内没有表示已发出；请到“已发送”里确认，草稿可能还在草稿箱`);
}

module.exports = { composeAddress, composeState, sendThroughPage, bareAddress, PROVIDERS };
