// The two pages the desktop host shows itself: the starting page until the local service answers, and the page that
// says it cannot start. The window has no system title bar, so both carry their own drag strip and window buttons. They
// use the app's own colors for the saved appearance (packages/coding-agent/web/css/tokens.css), so the app page that
// follows appears in the same colors, and they speak the interface language (ui-language.cjs).
// The starting page says roughly how long the wait is: about 20 seconds the first time, then about as long as the last
// start took, nothing when that was quick, and a calm note when this start takes clearly longer than expected.

/** Colors of the conversation column (--bg-panel and the text, line, hover, accent and danger tokens) per theme. */
const SHELL_COLORS = Object.freeze({
  classic: { scheme: 'dark', bg: '#1c1d1d', text: '#e3e5e5', text2: '#a8adad', text3: '#8a9090', line: '#303333', hover: '#2a2c2c', accent: '#79a8f5', danger: '#e8665f', onDanger: '#ffffff' },
  forest: { scheme: 'dark', bg: '#292e2b', text: '#e3e4df', text2: '#bfc3bd', text3: '#a5aaa3', line: '#464c47', hover: '#3c423e', accent: '#a7c080', danger: '#e9a09c', onDanger: '#2a1110' },
  amber: { scheme: 'dark', bg: '#302b28', text: '#e6e3df', text2: '#c6c0b9', text3: '#b0a89f', line: '#4e4640', hover: '#453d37', accent: '#d4ae82', danger: '#e9a09c', onDanger: '#2a1110' },
  light: { scheme: 'light', bg: '#fbfbfa', text: '#1d2020', text2: '#565c5c', text3: '#666b6b', line: '#dfe2e1', hover: '#edefee', accent: '#2c66d6', danger: '#b93a33', onDanger: '#ffffff' },
  lightForest: { scheme: 'light', bg: '#f0f4eb', text: '#1b201a', text2: '#4e574b', text3: '#5a6356', line: '#d2dacb', hover: '#e4ebde', accent: '#47773a', danger: '#b93a33', onDanger: '#ffffff' },
  lightAmber: { scheme: 'light', bg: '#f8f2e8', text: '#221e18', text2: '#59524a', text3: '#655d53', line: '#e0d6c6', hover: '#efe7da', accent: '#96632b', danger: '#b93a33', onDanger: '#ffffff' },
});

/** The colors for the saved Web UI preferences (null before any), decided as the page does it (boot-theme.js). */
function shellColors(prefs, systemDark) {
  const mode = prefs?.theme || 'system';
  const chatMode = prefs?.chatMode === 'general' ? 'general' : 'coding';
  const saved = prefs?.colorThemes?.[chatMode] ?? prefs?.colorTheme;
  const theme = ['classic', 'forest', 'amber'].includes(saved) ? saved : 'classic';
  if (mode === 'dark' || (mode === 'system' && systemDark)) return SHELL_COLORS[theme];
  return SHELL_COLORS[{ classic: 'light', forest: 'lightForest', amber: 'lightAmber' }[theme]];
}

/** Settings → Appearance → Animations: 'on', 'off', or 'system' (the page asks Windows through prefers-reduced-motion). */
const shellMotion = (prefs) => (prefs?.motion === 'on' || prefs?.motion === 'off' ? prefs.motion : 'system');

const FIRST_START_MS = 20000;
// A start that took less than this needs no hint.
const QUICK_START_MS = 8000;

/**
 * What the starting page says about the wait. `lastMs` is how long the last start took (none before the first one):
 * `hint` shows at once (empty when starting is quick), `later` replaces it once `laterMs` have passed since the app
 * started, and `expectMs` paces the progress line.
 */
function startWait(lastMs, say) {
  if (!(Number.isFinite(lastMs) && lastMs > 0)) {
    return {
      expectMs: FIRST_START_MS,
      hint: say('The first start takes about 20 seconds.', '第一次启动大约需要 20 秒。'),
      laterMs: 40000,
      later: say('This is taking a little longer than expected. Still starting…', '比预计的久一点，还在启动…'),
    };
  }
  const seconds = Math.max(5, Math.ceil(lastMs / 5000) * 5);
  return {
    expectMs: lastMs,
    hint: lastMs < QUICK_START_MS ? '' : say(`Usually takes about ${seconds} seconds.`, `通常需要约 ${seconds} 秒。`),
    laterMs: Math.round(Math.max(lastMs * 1.6, lastMs + 10000)),
    later: say('Taking a little longer than usual. Still starting…', '比平时久一点，还在启动…'),
  };
}

const escaped = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LOGO = '<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#1e1f1f"/><path d="M17 46V19l15 17" fill="none" stroke="#79a8f5" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 36l15-17v27" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GLYPH = {
  min: '<path d="M6 12h12"/>',
  max: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  restore: '<rect x="6" y="8.5" width="9.5" height="9.5" rx="1.5"/><path d="M8.5 8.5V7.5A1.5 1.5 0 0 1 10 6h6.5A1.5 1.5 0 0 1 18 7.5V14a1.5 1.5 0 0 1-1.5 1.5h-1"/>',
  close: '<path d="M6 18 18 6M6 6l12 12"/>',
};
const windowButton = (action, label, glyph, id) => `<button id="${id}" aria-label="${escaped(label)}" title="${escaped(label)}" onclick="myHarnessDesktop.windowControls.${action}()"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></button>`;

/** A whole host page: the drag strip, the window buttons (they follow the window's maximized state) and `content`. */
function shellPage({ lang, colors, motion, say, content, script = '' }) {
  const c = colors;
  const style = `:root{color-scheme:${c.scheme};--bg:${c.bg};--text:${c.text};--text-2:${c.text2};--text-3:${c.text3};--line:${c.line};--hover:${c.hover};--accent:${c.accent};--danger:${c.danger};--on-danger:${c.onDanger}}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}
.drag{position:fixed;top:0;left:0;right:0;height:44px;-webkit-app-region:drag}
.wc{position:fixed;top:0;right:0;height:44px;display:flex;color:var(--text-2);-webkit-app-region:no-drag}
.wc button{width:46px;height:44px;border:0;border-radius:0;background:transparent;color:inherit;display:inline-flex;align-items:center;justify-content:center}
.wc button:hover{background:var(--hover);color:var(--text)}
.wc #wc-close:hover{background:var(--danger);color:var(--on-danger)}
.page{box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 32px 48px;text-align:center}
.logo{width:64px;height:64px;border-radius:15px;box-shadow:0 8px 28px rgba(0,0,0,.22)}
h1{margin:20px 0 0;font-size:21px;line-height:1.3;font-weight:600;letter-spacing:-.01em}
.status{margin:6px 0 0;color:var(--text-2)}
.bar{width:220px;height:3px;margin-top:22px;border-radius:2px;background:var(--line);overflow:hidden}
.bar>i{display:block;height:100%;border-radius:inherit;background:var(--accent);transform-origin:left;transform:scaleX(0)}
.hint{min-height:1.5em;margin:14px 0 0;color:var(--text-3);font-size:13px;transition:opacity .3s ease}
.error{max-width:720px;margin:0 auto;text-align:left;align-items:stretch}
.error h1{margin-top:0}
.error pre{margin:16px 0 0;padding:12px 14px;max-height:45vh;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid var(--line);border-radius:8px;color:var(--text-2);font:12.5px/1.5 "Cascadia Mono",Consolas,monospace;user-select:text}
.error p{margin:12px 0 0;color:var(--text-2);user-select:text}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
${{ on: '.page{animation:in .4s cubic-bezier(.2,.7,.3,1) both}', off: '.hint{transition:none}', system: '@media (prefers-reduced-motion:no-preference){.page{animation:in .4s cubic-bezier(.2,.7,.3,1) both}}@media (prefers-reduced-motion:reduce){.hint{transition:none}}' }[motion] ?? ''}`;
  const sync = `<script>{const b=document.getElementById('wc-max'),c=window.myHarnessDesktop&&myHarnessDesktop.windowControls,g=${JSON.stringify({ max: GLYPH.max, restore: GLYPH.restore })},s=(v)=>{b.querySelector('svg').innerHTML=v&&v.maximized?g.restore:g.max;};if(c){c.state().then(s,()=>{});c.onState(s);}}</script>`;
  const buttons = `<div class="drag"></div><div class="wc">${windowButton('minimize', say('Minimize', '最小化'), GLYPH.min, 'wc-min')}${windowButton('toggleMaximize', say('Maximize / Restore', '最大化/还原'), GLYPH.max, 'wc-max')}${windowButton('close', say('Close', '关闭'), GLYPH.close, 'wc-close')}</div>`;
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><title>MyHarness</title><style>${style}</style><body>${buttons}${content}${sync}${script}</body></html>`;
}

/**
 * The starting page. `startedAt` is when the app process started (Date.now() time), so the hint and the progress line
 * count the whole wait, not only the part after this page appeared.
 */
function startingPage({ lang, colors, motion, say, startedAt, lastMs }) {
  const wait = startWait(lastMs, say);
  const content = `<main class="page">${LOGO}<h1>MyHarness</h1><p class="status">${escaped(say('Starting…', '正在启动…'))}</p><div class="bar"><i></i></div><p class="hint" id="hint">${escaped(wait.hint)}</p></main>`;
  // The line eases toward 94 % over the expected time and keeps creeping after it, never claiming to be done. It runs as
  // a compositor animation (no work on the page's thread while the service starts); without animations it steps.
  const script = `<script>{const started=${Number(startedAt) || 0},expect=${wait.expectMs},laterAt=${wait.laterMs},later=${JSON.stringify(wait.later).replace(/</g, '\\u003c')},mode=${JSON.stringify(motion)},motion=mode==='on'||(mode==='system'&&!matchMedia('(prefers-reduced-motion: reduce)').matches);
const bar=document.querySelector('.bar>i'),hint=document.getElementById('hint'),now=()=>Date.now()-started,at=(t)=>0.94*(1-Math.exp(-2.2*Math.max(0,t)/expect)),scale=(t)=>({transform:'scaleX('+at(t).toFixed(4)+')'});
if(motion&&bar.animate){const t=now(),k=Math.max(t+1,expect*1.6),frames=[];for(let i=0;i<=12;i++)frames.push({...scale(t+(k-t)*i/12),offset:i/12});
bar.animate(frames,{duration:k-t,easing:'linear',fill:'forwards'}).finished.then(()=>bar.animate([scale(k),{transform:'scaleX(0.97)'}],{duration:60000,easing:'ease-out',fill:'forwards'}),()=>{});}
else{const step=()=>Object.assign(bar.style,scale(now()));step();setInterval(step,1000);}
const swap=()=>{const show=()=>{hint.textContent=later;hint.style.opacity='1'};if(motion){hint.style.opacity='0';setTimeout(show,300)}else show();};
setTimeout(swap,Math.max(0,laterAt-now()));}</script>`;
  return shellPage({ lang, colors, motion, say, content, script });
}

/** The page that says MyHarness cannot start, with the reason and where the logs are. */
function cannotStartPage({ lang, colors, motion, say, message, logs }) {
  const content = `<main class="page error"><h1>${escaped(say('MyHarness cannot start', 'MyHarness 无法启动'))}</h1><pre>${escaped(message)}</pre><p>${escaped(say('Logs: ', '日志：'))}${escaped(logs)}</p><p>${escaped(say('Close the window and start MyHarness again.', '请关闭窗口后重新启动。'))}</p></main>`;
  return shellPage({ lang, colors, motion, say, content });
}

module.exports = { SHELL_COLORS, shellColors, shellMotion, startWait, startingPage, cannotStartPage, escaped };
