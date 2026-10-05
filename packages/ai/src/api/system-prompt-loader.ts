/** Central source for runtime-owned instructions. Files are UTF-8, never executable templates. */
const nodeProcess =
	typeof process !== "undefined" && typeof process.getBuiltinModule === "function" ? process : undefined;
const fs = nodeProcess?.getBuiltinModule("fs") as typeof import("node:fs") | undefined;
const path = nodeProcess?.getBuiltinModule("path") as typeof import("node:path") | undefined;
const url = nodeProcess?.getBuiltinModule("url") as typeof import("node:url") | undefined;

function defaultDirectory(): string {
	if (!fs || !path || !url) return "system-prompts";
	if (["$bunfs", "~BUN", "%7EBUN"].some((marker) => import.meta.url.includes(marker))) {
		return path.join(path.dirname(nodeProcess!.execPath), "system-prompts");
	}
	const moduleDir = path.dirname(url.fileURLToPath(import.meta.url));
	const repoRoot = path.resolve(moduleDir, "../../../..");
	try {
		if (JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).name === "myharness") {
			return path.join(repoRoot, "system-prompts");
		}
	} catch {
		// Installed packages carry an editable copy beside their compiled modules.
	}
	return path.resolve(moduleDir, "../system-prompts");
}

export const systemPromptDirectory = nodeProcess?.env.MYHARNESS_SYSTEM_PROMPT_DIR || defaultDirectory();

/** No fallback text: an invalid file is warned about and skipped. Restart to refresh module-level constants. */
export function loadSystemPrompt(
	file: string,
	variables: Readonly<Record<string, string>> = {},
	directory = systemPromptDirectory,
): string {
	let location = `${directory}/${file}`;
	try {
		if (!fs || !path) throw new Error("filesystem prompt loading is unavailable in this runtime");
		if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*\.md$/u.test(file)) throw new Error("invalid prompt path");
		// Keep the established logical resource names for SDK/tools; built-ins now live under common.
		const scoped = /^(common|coding|general)\//u.test(file);
		const legacyLocation = path.resolve(directory, file);
		location = scoped || fs.existsSync(legacyLocation) ? legacyLocation : path.resolve(directory, "common", file);
		const bytes = fs.readFileSync(location);
		let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n");
		if (!text.trim()) throw new Error("empty prompt");
		if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(text)) throw new Error("invalid text content");
		// One final newline belongs to the text file, not the original prompt literal.
		if (text.endsWith("\n")) text = text.slice(0, -1);
		return text.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/gu, (_match, name: string) => {
			if (!Object.hasOwn(variables, name)) throw new Error(`unknown or missing template variable: ${name}`);
			return variables[name];
		});
	} catch (error) {
		console.warn(
			`[system-prompts] warning: skipping ${location}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return "";
	}
}

/** Each nonempty line is one tool guideline; preserve order and wording. */
export function loadSystemPromptLines(file: string): string[] {
	return loadSystemPrompt(file)
		.split("\n")
		.filter((line) => line.trim().length > 0);
}
