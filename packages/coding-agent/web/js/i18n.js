// Translation lookup for text the MyHarness UI owns. English source text is the key: English mode returns it as is,
// so it can never show another language, and Chinese mode looks it up in locales/zh-CN.js (falling back to English).
import { getLang, isZh } from "./lang.js";
import { serverTextEn, serverTextZh, zhCN, zhUnits } from "./locales/zh-CN.js";

const CJK = new RegExp(`[${String.fromCharCode(0x3000)}-${String.fromCharCode(0x9fff)}${String.fromCharCode(0xff00)}-${String.fromCharCode(0xffef)}]`);
const FULLWIDTH_COLON = String.fromCharCode(0xff1a);

function fill(text, params) {
	return params ? text.replace(/\{(\w+)\}/g, (whole, key) => (params[key] === undefined ? whole : String(params[key]))) : text;
}

/** Translate a UI string. `{name}` placeholders are replaced from `params`. */
export function t(text, params) {
	return fill(isZh() ? (zhCN[text] ?? text) : text, params);
}

/** Marks text that is translated later (labels kept in constants); returns the text unchanged. Call `t()` where it is shown. */
export const N_ = (text) => text;

/**
 * Like `t()` for sentences that contain elements: `{name}` is replaced by `parts[name]` (a string or a vnode) and the
 * result is a list of nodes, so the word order of each language is kept.
 */
export function tNodes(text, parts) {
	const source = isZh() ? (zhCN[text] ?? text) : text;
	return source.split(/(\{\w+\})/).map((piece) => {
		const match = /^\{(\w+)\}$/.exec(piece);
		return match && parts[match[1]] !== undefined ? parts[match[1]] : piece;
	});
}

/** A counted noun. Chinese has no plural form, so it uses a measure word (zhUnits) instead of appending "s". */
export function count(n, singular, pluralForm) {
	if (isZh()) return `${n} ${zhUnits[singular] ?? singular}`;
	return `${n} ${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

/**
 * Text produced by the server in one fixed language (for example the run activity, which the terminal UI shows in
 * Chinese). English mode maps the known messages to English and never shows an unknown Chinese one.
 */
export function serverText(text, fallback = "") {
	if (!text) return fallback;
	if (isZh()) {
		if (zhCN[text] !== undefined) return zhCN[text];
		for (const [pattern, build] of serverTextZh.patterns) {
			const match = pattern.exec(text);
			if (match) return build(match);
		}
		return text;
	}
	if (!CJK.test(text)) return text;
	const known = serverTextEn.exact[text];
	if (known) return known;
	for (const [pattern, build] of serverTextEn.patterns) {
		const match = pattern.exec(text);
		if (match) return build(match);
	}
	// "<known Chinese lead>: <detail>" (full-width colon) keeps the detail, e.g. a path, and translates the lead.
	const split = new RegExp(`^([^${FULLWIDTH_COLON}]+)${FULLWIDTH_COLON}([^]*)$`).exec(text);
	const lead = split && serverTextEn.leads[split[1]];
	if (lead) {
		const detail = split[2].trim();
		return detail ? `${lead}: ${CJK.test(detail) ? serverText(detail) : detail}` : lead;
	}
	return fallback;
}

export { getLang, isZh };
