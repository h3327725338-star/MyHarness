// Desktop-only verification surface. The actual browser is a main-process native view.
import { html, useEffect, useRef, useState } from "./ui.js";
import { useStore } from "./store.js";

export function BrowserPanel() {
  const host = window.myHarnessDesktop;
  const open = useStore((s) => s.view.panelOpen);
  const lang = useStore((s) => s.view.lang);
  const zh = lang !== "en";
  const target = useRef(null);
  const [url, setUrl] = useState("https://github.com");
  const [error, setError] = useState("");
  useEffect(() => host.onStatus((value) => {
    if (value.url) setUrl(value.url);
    setError(value.error || "");
  }), []);
  useEffect(() => {
    if (!open) { host.destroy(); return; }
    let frame, last = "";
    const sync = () => {
      const element = target.current;
      const r = element?.getBoundingClientRect();
      // Native views sit above DOM: hide them while a modal/popover covers their region.
      const samples = r ? [[r.x + 2, r.y + 2], [r.right - 2, r.y + 2], [r.x + 2, r.bottom - 2], [r.right - 2, r.bottom - 2], [r.x + r.width / 2, r.y + r.height / 2]] : [];
      const visible = r && !document.hidden && !document.querySelector('[aria-modal="true"], .overlay-host') && samples.every(([x, y]) => {
        const top = document.elementFromPoint(x, y);
        return top === element || element.contains(top);
      });
      const rect = visible ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
      const next = JSON.stringify(rect);
      if (next !== last) { host.bounds(rect); last = next; }
      frame = requestAnimationFrame(sync);
    };
    const observer = new ResizeObserver(() => { last = ""; });
    if (target.current) observer.observe(target.current);
    sync();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); host.destroy(); };
  }, [open]);
  const navigate = async (event) => {
    event.preventDefault(); setError("");
    try { await host.navigate(url); } catch (e) { setError(e.message); }
  };
  return html`<div class="desktop-browser-panel">
    <form class="panel-toolbar" onSubmit=${navigate}><input class="field grow" aria-label=${zh ? "网页地址" : "Website URL"} value=${url} onInput=${(e) => setUrl(e.target.value)} /><button class="btn" type="submit">${zh ? "打开" : "Open"}</button></form>
    <div class="desktop-browser-target" ref=${target}>
      <div class="pad"><p role="status">${error || (zh ? "输入网址并打开，网页由桌面端真实浏览器显示。" : "Enter a URL to open the desktop browser view.")}</p><button class="btn" onClick=${() => host.external(url).catch((e) => setError(e.message))}>${zh ? "用系统浏览器打开" : "Open in system browser"}</button></div>
    </div>
  </div>`;
}
