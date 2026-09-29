// Pure unified-diff parsing (kept free of DOM/UI imports so it can be unit-tested).
export function parsePatch(patch) {
	const hunks = [];
	let hunk = null;
	let oldNo = 0;
	let newNo = 0;
	for (const line of String(patch || "").split("\n")) {
		const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
		if (m) {
			hunk = { header: line, section: m[3].trim(), oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] };
			hunks.push(hunk);
			oldNo = Number(m[1]);
			newNo = Number(m[2]);
			continue;
		}
		if (!hunk) continue;
		if (line.startsWith("\\")) {
			hunk.lines.push({ type: "meta", text: line.slice(2) });
		} else if (line.startsWith("+")) {
			hunk.lines.push({ type: "add", text: line.slice(1), newNo: newNo++ });
		} else if (line.startsWith("-")) {
			hunk.lines.push({ type: "del", text: line.slice(1), oldNo: oldNo++ });
		} else if (line.length > 0 || hunk.lines.length > 0) {
			// The trailing empty string after the final newline is not a context line.
			if (line === "" && hunk.lines.length && hunk.__done) continue;
			hunk.lines.push({ type: "ctx", text: line.startsWith(" ") ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ });
		}
	}
	// Drop the phantom trailing context line created by the final newline.
	const last = hunks[hunks.length - 1];
	if (last && last.lines.length) {
		const tail = last.lines[last.lines.length - 1];
		if (tail.type === "ctx" && tail.text === "" && String(patch).endsWith("\n")) last.lines.pop();
	}
	return hunks;
}
