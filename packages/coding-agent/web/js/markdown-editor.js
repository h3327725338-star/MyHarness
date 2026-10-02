import { html, useEffect, useRef, useState } from "./ui.js";
import { renderMarkdown } from "./markdown.js";
import { api } from "./store.js";
import { t } from "./i18n.js";

/** Keep untouched source blocks verbatim, including reference definitions and other Markdown extensions. */
export function editableBlocks(source) {
	const blocks = [];
	let offset = 0;
	for (const token of globalThis.marked.lexer(source, { gfm: true })) {
		const start = source.indexOf(token.raw, offset);
		if (start < offset) return [{ raw: source, type: "paragraph" }];
		if (start > offset) blocks.push({ raw: source.slice(offset, start), type: "def" });
		blocks.push({ raw: token.raw, type: token.type });
		offset = start + token.raw.length;
	}
	if (offset < source.length) blocks.push({ raw: source.slice(offset), type: "def" });
	return blocks;
}

export function MarkdownEditor({ file, path, onDirty }) {
	const root = useRef(null);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const baseline = useRef(file.content);
	const blocks = useRef([]);
	useEffect(() => {
		baseline.current = file.content;
		blocks.current = editableBlocks(file.content);
		const definitions = blocks.current.filter((block) => block.type === "def").map((block) => block.raw).join("\n");
		root.current.replaceChildren();
		for (const block of blocks.current) {
			const element = document.createElement("div");
			element.className = "markdown-edit-block";
			element.innerHTML = renderMarkdown(block.raw + (definitions ? `\n\n${definitions}` : ""));
			element.querySelectorAll(".code-block").forEach((codeBlock) => {
				const language = codeBlock.querySelector(".code-lang")?.textContent;
				if (language && language !== "text") codeBlock.querySelector("code").className = `language-${language}`;
			});
			element.querySelectorAll(".code-head").forEach((head) => head.remove());
			// An empty document still has a place to type. Invisible source-only blocks stay untouched.
			element.contentEditable = block.type === "space" || !element.textContent ? "false" : "true";
			element.setAttribute("role", "textbox");
			element.setAttribute("aria-label", t("Edit Markdown"));
			block.element = element;
			block.initial = element.innerHTML;
			root.current.append(element);
		}
		const extra = document.createElement("div");
		extra.className = "markdown-edit-block";
		extra.contentEditable = "true";
		extra.setAttribute("role", "textbox");
		extra.setAttribute("aria-label", t("Add text"));
		blocks.current.push({ raw: "", element: extra, initial: "" });
		root.current.append(extra);
		setDirty(false);
		setError("");
	}, [file, path]);
	useEffect(() => { onDirty?.(dirty); }, [dirty]);
	useEffect(() => {
		if (!dirty) return undefined;
		const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);
	const save = async () => {
		if (saving || !dirty) return;
		setSaving(true);
		setError("");
		try {
			const payload = blocks.current.map((block) => ({ raw: block.raw, ...(block.element.innerHTML !== block.initial ? { html: block.element.innerHTML } : {}) }));
			const result = await api("/api/files/markdown", { method: "POST", body: { path, original: baseline.current, blocks: payload } });
			baseline.current = result.content;
			payload.forEach((block, index) => {
				blocks.current[index].raw = result.blocks[index];
				blocks.current[index].initial = blocks.current[index].element.innerHTML;
			});
			setDirty(false);
		} catch (e) { setError(e.message); }
		finally { setSaving(false); }
	};
	return html`<div class="markdown-editor">
		<div class="panel-toolbar"><span class="dim grow">${t("Edit Markdown")}</span><button disabled=${saving || !dirty || file.truncated} onClick=${save}>${t("Save")}</button></div>
		<div class="panel-toolbar markdown-formatting" role="toolbar" aria-label=${t("Markdown formatting")}>
			${[["H1", "formatBlock", "h1"], ["H2", "formatBlock", "h2"], ["H3", "formatBlock", "h3"], ["H4", "formatBlock", "h4"], ["H5", "formatBlock", "h5"], ["H6", "formatBlock", "h6"], [t("Paragraph"), "formatBlock", "p"], [t("Bold"), "bold"], [t("Italic"), "italic"], [t("List"), "insertUnorderedList"], [t("Numbered list"), "insertOrderedList"], [t("Quote"), "formatBlock", "blockquote"], [t("Code"), "formatBlock", "pre"]].map(([label, command, value]) => html`<button disabled=${saving || file.truncated} onMouseDown=${(event) => event.preventDefault()} onClick=${() => { if (root.current.contains(window.getSelection()?.anchorNode)) document.execCommand(command, false, value); }}>${label}</button>`)}
			<button disabled=${saving || file.truncated} onMouseDown=${(event) => event.preventDefault()} onClick=${() => { if (!root.current.contains(window.getSelection()?.anchorNode)) return; const url = window.prompt(t("Link URL")); if (url && /^(https?:|mailto:|#|\/(?!\/)|\.{0,2}\/)/i.test(url)) document.execCommand("createLink", false, url); }}>${t("Link")}</button>
		</div>
		${file.truncated ? html`<div class="notice warn">${t("Truncated Markdown is read-only.")}</div>` : null}
		${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
		<div class="md markdown-edit-body" ref=${root} onInput=${() => setDirty(true)} onClick=${(event) => { if (event.target.closest("a")) event.preventDefault(); }} onKeyDown=${(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); save(); } }} onPaste=${(event) => { event.preventDefault(); document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); }} inert=${file.truncated || saving ? true : undefined} />
	</div>`;
}
