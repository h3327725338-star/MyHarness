/**
 * Links in an HTML file shown in a file tab. The page runs in a sandboxed frame of the app page
 * (`/api/files/site/<token>/…`, packages/coding-agent/src/modes/web/html-preview.ts). A link to another site would load
 * that site inside the frame, and most sites refuse to be framed, which leaves a blank page. Such a link opens as a
 * website tab instead, the way a browser opens a page; links between the file's own pages still navigate the frame.
 *
 * `serviceUrl()` is the app's current address (it changes when the service restarts) and `open(url)` opens a website tab.
 */
const SITE_PATH = '/api/files/site/';

/** The address a preview frame's navigation should open as a website tab, or null when the frame may navigate. */
exports.previewLinkTarget = ({ serviceUrl, frameUrl, targetUrl, topLevelFrame }) => {
  if (!serviceUrl || !topLevelFrame) return null;
  let service, source, target;
  try { service = new URL(serviceUrl); source = new URL(frameUrl); target = new URL(targetUrl); } catch { return null; }
  if (source.origin !== service.origin || !source.pathname.startsWith(SITE_PATH)) return null;
  if (target.origin === service.origin || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
  return target.href;
};

exports.attachPreviewLinks = (contents, { serviceUrl, open, log = () => {} }) => {
  // A page that keeps redirecting itself must not flood the panel with tabs.
  let last = { url: '', at: 0 };
  contents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    const frame = details.frame;
    // Only the preview frame itself: its parent is the app page, which has no parent.
    const url = exports.previewLinkTarget({ serviceUrl: serviceUrl(), frameUrl: frame?.url || '', targetUrl: details.url, topLevelFrame: !!frame?.parent && !frame.parent.parent });
    if (!url) return;
    details.preventDefault();
    const now = Date.now();
    if (last.url === url && now - last.at < 1500) return;
    last = { url, at: now };
    Promise.resolve().then(() => open(url)).catch((error) => log(`无法在内置浏览器打开预览中的链接：${error.message}`));
  });
};
