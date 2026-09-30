// Formatting helpers and small pure utilities.
import { N_, count, t } from "./i18n.js";
import { getLang } from "./lang.js";

/** Reasoning-effort levels: the level name (translated) and a one-line hint. */
const EFFORT_NAME = { off: N_("off"), minimal: N_("minimal"), low: N_("low"), medium: N_("medium"), high: N_("high"), xhigh: N_("xhigh"), max: N_("max") };
const EFFORT_HINT = { off: N_("No extra reasoning"), minimal: N_("Minimal"), low: N_("Light"), medium: N_("Balanced"), high: N_("Deep"), xhigh: N_("Very deep"), max: N_("Maximum") };
export const effortName = (level) => (EFFORT_NAME[level] ? t(EFFORT_NAME[level]) : level);
export const effortHint = (level) => (EFFORT_HINT[level] ? t(EFFORT_HINT[level]) : "");

/** Efforts for a model reference of a setting (provider + model), or the current main model when none is chosen. */
export function refEffortModel(models, mainModel, ref) {
	if (ref?.provider && ref?.model) return models?.providers?.find((g) => g.id === ref.provider)?.models.find((m) => m.id === ref.model);
	return mainModel;
}

/** Title of a saved chat: its name, else the first message. The storage layer's "(no messages)" placeholder counts as no message. */
export function chatTitle(info) {
	const first = info.firstMessage === "(no messages)" ? "" : info.firstMessage || "";
	return info.name || clip(first.replace(/\s+/g, " ").trim(), 80) || t("Untitled chat");
}

export function normPath(p) {
	return String(p || "").replace(/\\/g, "/");
}

export function basename(p) {
	const n = normPath(p).replace(/\/+$/, "");
	const i = n.lastIndexOf("/");
	return i < 0 ? n : n.slice(i + 1);
}

export function dirname(p) {
	const n = normPath(p).replace(/\/+$/, "");
	const i = n.lastIndexOf("/");
	return i < 0 ? "" : n.slice(0, i);
}

/** Show a path relative to cwd when it lies inside it (Windows-insensitive). */
export function shortPath(p, cwd) {
	const n = normPath(p);
	const c = normPath(cwd).replace(/\/+$/, "");
	if (c && n.toLowerCase().startsWith(`${c.toLowerCase()}/`)) return n.slice(c.length + 1);
	if (c && n.toLowerCase() === c.toLowerCase()) return ".";
	return n;
}

export function fmtDuration(ms) {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return t("{s}s", { s: total });
	const m = Math.floor(total / 60);
	const s = total % 60;
	if (m < 60) return s ? t("{m}m {s}s", { m, s }) : t("{m}m", { m });
	return t("{h}h {m}m", { h: Math.floor(m / 60), m: m % 60 });
}

export function fmtShortDuration(ms) {
	if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	return fmtDuration(ms);
}

/** Compact "how long ago" for narrow columns: 5m, 2h, 3d. */
export function relTime(ts) {
	if (!ts) return "";
	const diff = Date.now() - ts;
	const min = Math.floor(diff / 60000);
	if (min < 1) return t("now");
	if (min < 60) return t("{n}m", { n: min });
	const hr = Math.floor(diff / 3600000);
	if (hr < 24) return t("{n}h", { n: hr });
	const day = Math.floor(diff / 86400000);
	if (day < 7) return t("{n}d", { n: day });
	if (day < 30) return t("{n}w", { n: Math.floor(day / 7) });
	if (day < 365) return t("{n}mo", { n: Math.floor(day / 30) });
	return t("{n}y", { n: Math.floor(day / 365) });
}

export function fmtDateTime(ts) {
	if (!ts) return "";
	return new Date(ts).toLocaleString(getLang(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtTokens(n) {
	if (n == null) return "–";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtCost(v) {
	if (!v) return "$0";
	return v < 0.01 ? `<$0.01` : `$${v.toFixed(v < 1 ? 3 : 2)}`;
}

/** A counted noun: "3 files" in English, with a measure word in Chinese (see i18n.js count). */
export function plural(n, one, many) {
	return count(n, one, many);
}

export function clip(text, n) {
	const s = String(text ?? "");
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function firstLine(text) {
	return String(text ?? "").trim().split(/\r?\n/)[0];
}

let counter = 0;
export function uid(prefix = "id") {
	counter += 1;
	return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function safeJson(value, space = 2) {
	try {
		return JSON.stringify(value, null, space);
	} catch {
		return String(value);
	}
}

/**
 * Readable form of structured data (tool arguments, result details). JSON.stringify would show every line break inside
 * a string as a literal "\n", which makes commands, file contents and diffs unreadable; here multi-line text keeps its
 * real line breaks and each value sits under its own key.
 */
export function formatData(value, depth = 0) {
	const pad = "  ".repeat(depth);
	const scalar = (v) => (v === null ? "null" : v === undefined ? "" : typeof v === "string" ? (v === "" ? '""' : v) : String(v));
	const block = (text, indent) => text.replace(/\r\n?/g, "\n").split("\n").map((line) => `${indent}${line}`).join("\n");
	if (value === null || typeof value !== "object") {
		return typeof value === "string" && depth === 0 ? value : `${pad}${scalar(value)}`;
	}
	const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
	if (!entries.length) return `${pad}${Array.isArray(value) ? "[]" : "{}"}`;
	return entries
		.map(([key, v]) => {
			const label = Array.isArray(value) ? "-" : `${key}:`;
			if (typeof v === "string" && /[\r\n]/.test(v)) return `${pad}${label}${Array.isArray(value) ? "" : " |"}\n${block(v, `${pad}  `)}`;
			if (v !== null && typeof v === "object") return Object.keys(v).length ? `${pad}${label}\n${formatData(v, depth + 1)}` : `${pad}${label} ${Array.isArray(v) ? "[]" : "{}"}`;
			return `${pad}${label} ${scalar(v)}`;
		})
		.join("\n");
}

// ---- ANSI (SGR) -> spans -----------------------------------------------------------------
const ANSI_COLORS = ["#6b7070", "#e06c6c", "#63c08a", "#d9b95b", "#6f9bf0", "#b98ae0", "#5cc2c8", "#c8cccc"];
const ANSI_BRIGHT = ["#8a9090", "#f08a8a", "#83d9a6", "#ecd07a", "#8fb3f7", "#cfa8ee", "#7edbe0", "#f0f2f2"];

export function stripAnsi(text) {
	return String(text).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

/** Convert ANSI colour escapes to [{text, style}] segments (colours, bold, dim, underline). */
export function ansiSegments(text) {
	const segments = [];
	let style = {};
	let last = 0;
	const re = /\u001b\[([0-9;]*)m/g;
	let match;
	const push = (chunk) => {
		if (chunk) segments.push({ text: stripAnsi(chunk), style: { ...style } });
	};
	const src = String(text);
	while ((match = re.exec(src))) {
		push(src.slice(last, match.index));
		last = match.index + match[0].length;
		const codes = match[1] === "" ? [0] : match[1].split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const c = codes[i];
			if (c === 0) style = {};
			else if (c === 1) style.fontWeight = "600";
			else if (c === 2) style.opacity = "0.7";
			else if (c === 4) style.textDecoration = "underline";
			else if (c === 22) {
				delete style.fontWeight;
				delete style.opacity;
			} else if (c === 24) delete style.textDecoration;
			else if (c >= 30 && c <= 37) style.color = ANSI_COLORS[c - 30];
			else if (c >= 90 && c <= 97) style.color = ANSI_BRIGHT[c - 90];
			else if (c === 39) delete style.color;
			else if (c === 38 && codes[i + 1] === 5) {
				const n = codes[i + 2];
				i += 2;
				if (n < 8) style.color = ANSI_COLORS[n];
				else if (n < 16) style.color = ANSI_BRIGHT[n - 8];
			} else if (c === 38 && codes[i + 1] === 2) {
				style.color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
				i += 4;
			}
		}
	}
	push(src.slice(last));
	return segments;
}

// ---- Preferences (localStorage, best-effort) ---------------------------------------------
const PREF_KEY = "myharness.web.prefs";
export function loadPrefs() {
	try {
		return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {};
	} catch {
		return {};
	}
}
export function savePrefs(prefs) {
	try {
		localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
	} catch {
		// storage unavailable: preferences just will not persist
	}
}

export function debounce(fn, ms) {
	let timer;
	return (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
}

/** Classify a finished shell tool result: "cancelled" (user stopped it), "timeout", or null. */
export function shellOutcome(result) {
	const text = String(result?.text || "");
	if (/(^|\n)Command aborted\s*$/.test(text)) return "cancelled";
	if (result?.details?.errorCode === "BASH_TIMEOUT" || /Command timed out after \d+ seconds\s*$/.test(text)) return "timeout";
	return null;
}

// A list scrolled from the keyboard slides under a resting mouse pointer; that must not move the highlight. Only a
// pointer that really moved (another screen position than the last event) counts as choosing with the mouse.
let lastPointer = "";
export function pointerMoved(event) {
	const at = `${event.screenX},${event.screenY}`;
	if (at === lastPointer) return false;
	lastPointer = at;
	return true;
}
