/**
 * Standalone HTML replay shell runtime (window.__MYHARNESS_EXPORT__).
 *
 * Implements the client-side shim for offline single-file playback:
 * - Intercepts fetch via embedded route table
 * - EventSource stub to report connected state without reconnection attempts
 * - Enforces read-only DOM states for offline buttons
 * - Provides raw JSONL download via Blob
 *
 * Styling is supplied by the frontend CSS (layout.css, composer.css) and not duplicated here.
 */

export const DATA_ELEMENT_ID = "myharness-export-data";

/**
 * Serialize a value as JSON for embedding inside an inline <script> block.
 *
 * Every '<' becomes the JSON escape \u003C. JSON.parse restores the original
 * text losslessly, and the serialized block can never carry a literal
 * `<script` plus `<!--` sequence — the combination that puts the HTML parser
 * into the script escaped state (R3a H-2), where the real `</script>` no
 * longer closes the element and the block swallows the boot script and body
 * (blank export page).
 */
export function safeJsonForScript(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003C");
}

export const OFFLINE_DISABLED_LABELS = [
	"Changes",
	"文件变更",
	"改动",
	"Files",
	"文件",
	"Terminal",
	"终端",
	"Add workspace",
	"添加工作区",
	"New chat",
	"新对话",
] as const;

export interface BootScriptOptions {
	exportedAt: string;
	sourceName: string;
	sourcePath: string;
	missingRoutePolicy?: "empty" | "fail";
}

export function bootScript({
	exportedAt,
	sourceName,
	sourcePath,
	missingRoutePolicy = "empty",
}: BootScriptOptions): string {
	return `(function () {
	var el = document.getElementById(${safeJsonForScript(DATA_ELEMENT_ID)});
	var data = {};
	try { data = JSON.parse(el ? el.textContent : "{}"); } catch (e) { data = { error: "export data unreadable: " + e.message }; }
	var prefs = data.prefs || {};

	var root = document.documentElement;
	root.lang = prefs.lang === "zh-CN" ? "zh-CN" : "en";
	var mode = prefs.theme || "system";
	var dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
	root.dataset.theme = dark ? "dark" : "light";
	var chatMode = prefs.chatMode === "general" ? "general" : "coding";
	var themes = prefs.colorThemes || {};
	var selected = function (m) {
		var v = themes[m] !== undefined ? themes[m] : prefs.colorTheme;
		return ["classic", "forest", "amber"].indexOf(v) >= 0 ? v : m === "general" ? "forest" : "classic";
	};
	root.dataset.colorTheme = selected(chatMode);
	root.dataset.codingColorTheme = selected("coding");
	root.dataset.generalColorTheme = selected("general");
	root.dataset.chatMode = chatMode;
	if (prefs.motion) root.dataset.motion = prefs.motion;
	root.dataset.exportReadonly = "1";

	var routes = data.routes || {};
	var missing = [];
	function key(pathname, search) { return pathname + (search || ""); }
	function lookup(path, query) {
		var u = new URL(path, "http://export.invalid");
		var pathname = u.pathname;
		var search = u.search;
		var exact = routes[key(pathname, search)];
		if (exact !== undefined) return exact;
		var byPath = routes[pathname];
		if (byPath !== undefined) return byPath;
		for (var k in routes) {
			if (k.indexOf(pathname + "?") === 0) {
				var want = new URL("http://export.invalid" + k.slice(pathname.length));
				var same = true;
				want.searchParams.forEach(function (v, kk) { if (query.get(kk) !== v) same = false; });
				if (same) return routes[k];
			}
		}
		missing.push(path);
		return routes["*"];
	}

	function jsonResponse(body, status) {
		var text = body === undefined ? "" : JSON.stringify(body);
		return {
			ok: (status || 200) >= 200 && (status || 200) < 300,
			status: status || 200,
			headers: { get: function (n) { return (n || "").toLowerCase() === "content-type" ? "application/json" : null; } },
			text: function () { return Promise.resolve(text); },
			json: function () { return Promise.resolve(body); },
		};
	}

	var fakeFetch = function (path, init) {
		var method = ((init && init.method) || "GET").toUpperCase();
		var query = new URL(path, "http://export.invalid").searchParams;
		if (method !== "GET" && method !== "HEAD") {
			return Promise.resolve(jsonResponse({ error: "Read only" }, 405));
		}
		var found = lookup(path, query);
		if (found === undefined) {
			${missingRoutePolicy === "fail" ? 'return Promise.resolve(jsonResponse({ error: "Not found" }, 404));' : "return Promise.resolve(jsonResponse({}));"}
		}
		return Promise.resolve(jsonResponse(found, 200));
	};

	function stubEventSource() {
		var listeners = {};
		var self = {
			readyState: 1,
			url: "about:blank",
			withCredentials: false,
			onopen: null,
			onerror: null,
			onmessage: null,
			addEventListener: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
			removeEventListener: function (name, fn) { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); },
			close: function () { self.readyState = 2; },
			dispatchEvent: function () { return false; },
		};
		setTimeout(function () { try { if (self.onopen) self.onopen({ type: "open" }); } catch (e) {} }, 0);
		self.__listeners = listeners;
		return self;
	}

	function enforceReadOnlyDom() {
		var labels = ${safeJsonForScript(OFFLINE_DISABLED_LABELS)};
		var nodes = document.querySelectorAll("button, [role=button], a");
		for (var i = 0; i < nodes.length; i++) {
			var node = nodes[i];
			var shouldDisable = false;
			if (node.hasAttribute("data-export-offline")) {
				shouldDisable = true;
			} else {
				var text = (node.getAttribute("aria-label") || "") + "|" + (node.getAttribute("title") || "");
				for (var j = 0; j < labels.length; j++) {
					if (text.indexOf(labels[j]) >= 0) {
						shouldDisable = true;
						break;
					}
				}
			}
			if (shouldDisable) {
				node.disabled = true;
				node.setAttribute("aria-disabled", "true");
				node.classList.add("export-offline");
				node.tabIndex = -1;
			}
		}
	}

	function downloadJsonl() {
		var blob = new Blob([data.rawJsonl || ""], { type: "application/x-ndjson" });
		var a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = (data.meta && data.meta.sessionId ? data.meta.sessionId : "session") + ".jsonl";
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
	}

	window.__MYHARNESS_EXPORT__ = {
		version: 1,
		data: data,
		prefs: prefs,
		routes: routes,
		meta: data.meta || {},
		// W128: these JSON literals can carry a hostile source path (sourceName /
		// sourcePath come from the session file path);
		// embed them through safeJsonForScript so no raw '<' reaches the parser.
		// The JS escapes restore the original values at runtime.
		exportedAt: ${safeJsonForScript(exportedAt)},
		export: {
			sourceName: ${safeJsonForScript(sourceName)},
			sourcePath: ${safeJsonForScript(sourcePath)},
			exportedAt: ${safeJsonForScript(exportedAt)},
		},
		fetch: fakeFetch,
		createEventSource: function () { return stubEventSource(); },
		downloadJsonl: downloadJsonl,
		missingRoutes: missing,
		enforceReadOnlyDom: enforceReadOnlyDom,
	};

	var mo = new MutationObserver(function () { enforceReadOnlyDom(); });
	function startObserver() {
		if (!document.body) return setTimeout(startObserver, 30);
		mo.observe(document.body, { childList: true, subtree: true });
		enforceReadOnlyDom();
	}
	startObserver();
})();
`;
}
