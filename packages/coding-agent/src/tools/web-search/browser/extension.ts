import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Firefox extension that lets MyHarness read search pages from a real
 * browser. It is written to disk at launch and installed as a temporary
 * add-on into MyHarness' own Firefox profile (never the user's profile).
 *
 * Communication: the background script long-polls
 * http://127.0.0.1:<port>/<token>/poll for one command at a time and posts
 * the answer to /<token>/result. The random token keeps other local pages and
 * processes from driving the browser; the bridge listens on loopback only.
 *
 * Commands:
 * - open  {url, selector, timeoutMs, settleMs, foreground} → page snapshot
 * - read  {tabId, selector}                                → page snapshot
 * - close {tabId}
 * - ping                                                   → {userAgent}
 *
 * A snapshot is {tabId, url, status, title, html, ready}: `ready` says whether
 * `selector` matched; `status` is the HTTP status of the tab's last top-level
 * response (0 when unknown).
 */

export const EXTENSION_ID = "web-search@myharness.local";

const MANIFEST = {
	manifest_version: 2,
	name: "MyHarness Web Search",
	version: "1.0",
	description: "Lets MyHarness read search result pages in this dedicated Firefox profile.",
	permissions: ["tabs", "webNavigation", "webRequest", "<all_urls>"],
	background: { scripts: ["config.js", "background.js"], persistent: true },
	browser_specific_settings: { gecko: { id: EXTENSION_ID, strict_min_version: "115.0" } },
};

// Plain ES2020 without template literals so it can live inside this TS string.
const BACKGROUND = `"use strict";
var BASE = "http://127.0.0.1:" + MYHARNESS_BRIDGE.port + "/" + MYHARNESS_BRIDGE.token;
var NAVIGATION_ABORTED = "Error code 2152398850";
var statusByTab = new Map();
var navErrorByTab = new Map();

browser.webRequest.onHeadersReceived.addListener(function (details) {
  if (details.type === "main_frame" && details.tabId >= 0) statusByTab.set(details.tabId, details.statusCode);
}, { urls: ["<all_urls>"], types: ["main_frame"] });
browser.webNavigation.onErrorOccurred.addListener(function (details) {
  if (details.frameId === 0 && details.error !== NAVIGATION_ABORTED) {
    navErrorByTab.set(details.tabId, { error: details.error, at: Date.now() });
  }
});
// Cleared when a new top-level navigation starts; an error page committing afterwards keeps it.
browser.webNavigation.onBeforeNavigate.addListener(function (details) {
  if (details.frameId === 0 && !/^about:/.test(details.url)) navErrorByTab.delete(details.tabId);
});
browser.tabs.onRemoved.addListener(function (tabId) {
  statusByTab.delete(tabId);
  navErrorByTab.delete(tabId);
});

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function probeCode(selector) {
  return "(function(){var s=" + JSON.stringify(selector || "") + ";var ready=false;try{ready=!!(s&&document.querySelector(s));}catch(e){}" +
    "return {url:location.href,state:document.readyState,ready:ready};})()";
}
var SNAPSHOT_CODE = "({url:location.href,title:document.title,html:document.documentElement?document.documentElement.outerHTML:''})";

async function probe(tabId, selector) {
  var results = await browser.tabs.executeScript(tabId, { code: probeCode(selector), runAt: "document_start" });
  return results && results[0];
}

async function snapshot(tabId, ready) {
  var results = await browser.tabs.executeScript(tabId, { code: SNAPSHOT_CODE, runAt: "document_start" });
  var page = results && results[0];
  if (!page) throw new Error("page is not readable");
  return { tabId: tabId, url: page.url, title: page.title, html: page.html, ready: ready, status: statusByTab.get(tabId) || 0 };
}

async function waitForPage(tabId, selector, timeoutMs, settleMs) {
  var deadline = Date.now() + timeoutMs;
  var lastUrl = "";
  var completeSince = 0;
  var unreadableSince = 0;
  while (Date.now() < deadline) {
    var info = null;
    try { info = await probe(tabId, selector); } catch (e) { info = null; }
    var navError = navErrorByTab.get(tabId);
    if (navError && Date.now() - navError.at > 1500) throw new Error("page load failed: " + navError.error);
    if (!info) {
      // Firefox's own error pages (connection refused, DNS failure, ...) finish loading
      // but cannot be scripted by extensions.
      var tab = await browser.tabs.get(tabId).catch(function () { return null; });
      if (!tab) throw new Error("the tab was closed");
      if (tab.status === "complete" && /^https?:/.test(tab.url || "")) {
        if (!unreadableSince) unreadableSince = Date.now();
        if (Date.now() - unreadableSince > 2500) throw new Error("page load failed: " + (tab.title || tab.url));
      } else unreadableSince = 0;
    } else unreadableSince = 0;
    if (info) {
      if (info.ready) return snapshot(tabId, true);
      if (info.state === "complete" && info.url === lastUrl && info.url !== "about:blank") {
        if (!completeSince) completeSince = Date.now();
        if (Date.now() - completeSince >= settleMs) return snapshot(tabId, false);
      } else completeSince = 0;
      lastUrl = info.url;
    }
    await sleep(250);
  }
  var last = null;
  try { last = await snapshot(tabId, false); } catch (e) { last = null; }
  if (last) return last;
  throw new Error("page load timed out");
}

async function run(command) {
  if (command.type === "ping") return { userAgent: navigator.userAgent };
  if (command.type === "open") {
    var tab = await browser.tabs.create({ url: command.url, active: !!command.foreground });
    if (command.foreground) {
      try { await browser.windows.update(tab.windowId, { focused: true, drawAttention: true }); } catch (e) {}
    }
    try {
      return await waitForPage(tab.id, command.selector, command.timeoutMs, command.settleMs);
    } finally {
      if (!command.keepOpen) await browser.tabs.remove(tab.id).catch(function () {});
    }
  }
  if (command.type === "read") {
    var info = await probe(command.tabId, command.selector);
    return snapshot(command.tabId, !!(info && info.ready));
  }
  if (command.type === "close") {
    await browser.tabs.remove(command.tabId).catch(function () {});
    return {};
  }
  throw new Error("unknown command " + command.type);
}

async function handle(command) {
  var reply;
  try { reply = { id: command.id, ok: true, result: await run(command) }; }
  catch (error) { reply = { id: command.id, ok: false, error: String((error && error.message) || error) }; }
  await fetch(BASE + "/result", { method: "POST", body: JSON.stringify(reply) }).catch(function () {});
}

async function loop() {
  while (true) {
    try {
      var response = await fetch(BASE + "/poll", { cache: "no-store" });
      if (response.status === 200) handle(await response.json());
      else if (response.status !== 204) await sleep(1000);
    } catch (error) {
      await sleep(1000);
    }
  }
}
loop();
`;

/** Write the extension into `dir`, pointing it at the bridge on `port` with `token`. */
export function writeExtension(dir: string, bridge: { port: number; token: string }): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(MANIFEST, null, 2)}\n`);
	writeFileSync(join(dir, "config.js"), `var MYHARNESS_BRIDGE = ${JSON.stringify(bridge)};\n`);
	writeFileSync(join(dir, "background.js"), BACKGROUND);
}
