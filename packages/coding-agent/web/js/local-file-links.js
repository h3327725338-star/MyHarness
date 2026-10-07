export function localLinkPath(href) {
	if (!href || /[\x00-\x1f]/.test(href)) return null;
	if (/^\/api\/artifacts\/download\?/i.test(href)) {
		return href;
	}
	if (/^file:\/\//i.test(href) || /^[a-z]:[\\/]/i.test(href)) return href;
	if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/|\\\\|\/api\/)/i.test(href)) return null;
	try { return decodeURIComponent(href); } catch { return href; }
}

export function pathCandidates(text) {
	const pattern = /(?:[a-z]:[\\/][^\s<>"'`|*?]+|file:\/\/[^\s<>"'`]+|(?:\.{1,2}[\\/]|\/)?[\p{L}\p{N}_@+.-]+(?:[\\/][\p{L}\p{N}_@+.-]+)+[\\/]?|[\p{L}\p{N}_@+-][\p{L}\p{N}_@+.-]*\.[a-z\d]{1,12})/giu;
	const result = [];
	for (const match of text.matchAll(pattern)) {
		const value = match[0].replace(/[.,;:!?\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F)\]}]+$/u, "");
		const previous = text.slice(Math.max(0, match.index - 10), match.index);
		if (!value || /(?:https?:\/\/|mailto:|sandbox:|[\p{L}\p{N}_/\\])$/iu.test(previous)) continue;
		if (localLinkPath(value)) result.push({ start: match.index, end: match.index + value.length, path: value });
	}
	return result;
}
