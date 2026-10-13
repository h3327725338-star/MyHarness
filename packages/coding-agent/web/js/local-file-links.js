export function localLinkPath(href) {
	if (!href || /[\x00-\x1f]/.test(href)) return null;
	if (/^\/api\/artifacts\/download\?/i.test(href)) {
		return href;
	}
	if (/^file:\/\//i.test(href) || /^[a-z]:[\\/]/i.test(href)) return href;
	if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/|\\\\|\/api\/)/i.test(href)) return null;
	try { return decodeURIComponent(href); } catch { return href; }
}

// W111: extensions (and dotless names like Makefile) that must not become local-file autolinks.
// Auto-recognized bare names/paths with these suffixes stay plain text; explicit `[text](path)`
// links bypass this list entirely (they go through localLinkPath, not this check).
// Source: W77 map section 3, ticket 3 (85 entries, kept verbatim, no additions).
export const LOCAL_AUTOLINK_BLOCKLIST = new Set(
	"ts tsx js jsx mjs cjs vue svelte astro json jsonc yaml yml toml ini cfg conf env lock properties md mdx txt rtf rst tex html htm xml svg css scss sass less sh bash zsh fish ps1 psm1 bat cmd rs go java kt kts swift c h cpp hpp cc cxx cs zig nim py pyw rb php pl pm lua r dart scala clj cljs ex exs erl hs jl sql csv tsv log diff patch proto wasm dockerfile makefile gradle".split(" "),
);

/** True when an auto-recognized candidate must stay plain text (blocklisted suffix or www-looking). */
export function isLocalAutolinkBlocked(value) {
	if (typeof value !== "string") return false;
	let text = value.trim();
	if (!text) return false;
	if (/^www\./i.test(text)) return true;
	const cut = text.search(/[?#]/);
	if (cut >= 0) text = text.slice(0, cut);
	const base = text.replace(/\\/g, "/").split("/").pop() || "";
	if (!base || base === "." || base === "..") return false;
	const lower = base.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot < 0) return LOCAL_AUTOLINK_BLOCKLIST.has(lower);
	const ext = lower.slice(dot + 1);
	if (!ext) return false;
	return LOCAL_AUTOLINK_BLOCKLIST.has(ext);
}

/**
 * Trim characters that almost never belong to a local path tail.
 * Keeps "/\\:" so directory tails like `unbound/memory/` survive, but drops
 * operators (`+=`), ASCII/fullwidth punctuation and trailing Chinese quantifiers
 * like `42张` / `2张` that follow a path in chat text (e.g. "`C:/a/b/` 42张 + ...").
 * Pure Chinese directory names without a leading digit (e.g. `C:/用户/文档`)
 * are preserved: only a trailing `<digits><quantifier>` suffix is removed.
 */
export function cleanLocalPath(raw) {
	let value = String(raw ?? "");
	for (let round = 0; round < 4; round++) {
		const before = value;
		value = value.replace(/[.,;:!?+=&%#^~|*()[\]{}<>"'`\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3001\uFF08\uFF09\u300A\u300B\u300C\u300D\u300E\u300F\u201C\u201D\u2018\u2019\u2014\u2026\u00B7]+$/u, "");
		value = value.replace(/[0-9\uFF10-\uFF19]+\s*[\u5F20\u4E2A\u53EA\u4EF6\u4EFD\u9875\u7BC7\u6761\u884C\u5217\u4F4D\u6B21\u79CD\u5E45\u7EC4\u6BB5\u7AE0\u8282\u53E5\u5B57\u8BCD\u5757\u5957\u5904\u56E2\u5806]+$/u, "");
		if (value === before) break;
	}
	return value;
}

export function pathCandidates(text) {
	const pattern = /(?:[a-z]:[\\/][^\s<>"'`|*?]+|file:\/\/[^\s<>"'`]+|(?:\.{1,2}[\\/]|\/)?[\p{L}\p{N}_@+.-]+(?:[\\/][\p{L}\p{N}_@+.-]+)+[\\/]?|[\p{L}\p{N}_@+-][\p{L}\p{N}_@+.-]*\.[a-z\d]{1,12})/giu;
	const result = [];
	for (const match of text.matchAll(pattern)) {
		const value = cleanLocalPath(match[0]);
		if (/^www\./i.test(value)) continue;
		const previous = text.slice(Math.max(0, match.index - 10), match.index);
		if (!value || /(?:https?:\/\/|mailto:|sandbox:|[\p{L}\p{N}_/\\])$/iu.test(previous)) continue;
		if (localLinkPath(value)) result.push({ start: match.index, end: match.index + value.length, path: value });
	}
	return result;
}
