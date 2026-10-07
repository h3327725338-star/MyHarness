import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { win32 as windowsPath } from "node:path";
import ignore from "ignore";
import { getAgentDir } from "../../config.ts";
import {
	getWorkspaceIdentity,
	isInsideWorkspace,
	normalizeDocumentPath,
	normalizeWorkspaceRoot,
	relativeToWorkspace,
} from "../path-semantics.ts";

/** Symbol categories emitted by the lightweight source parser. */
export type IndexedCodeSymbolKind =
	| "class"
	| "function"
	| "method"
	| "interface"
	| "type"
	| "enum"
	| "namespace"
	| "module"
	| "struct"
	| "trait"
	| "variable"
	| "constant";

export interface IndexedCodeSymbol {
	id: string;
	path: string;
	language: string;
	kind: IndexedCodeSymbolKind;
	name: string;
	parentName?: string;
	line: number;
	endLine: number;
	signature: string;
	exported: boolean;
	hash: string;
	updatedAt: number;
}

export interface IndexedCodeReference {
	source: string;
	target: string;
	path: string;
	line: number;
	text: string;
	referenceKind: "definition" | "reference";
}

export interface CodeSearchMatch {
	path: string;
	line: number;
	text: string;
}

export interface CodeMapEntry {
	path: string;
	language: string;
	symbols: IndexedCodeSymbol[];
}

export interface CodeIndexStats {
	fileCount: number;
	symbolCount: number;
	lastUpdated?: number;
	storagePath: string;
}

export interface CodeIndexRefreshSummary {
	added: number;
	updated: number;
	removed: number;
	unchanged: number;
	skipped: number;
	limited: boolean;
	fileCount: number;
	symbolCount: number;
}

export interface CodeIndexOptions {
	cwd: string;
	agentDir?: string;
	maxFiles?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
}

export interface CodeQueryOptions {
	path?: string;
	limit?: number;
	signal?: AbortSignal;
	/** Internal: use a refresh summary already captured by the caller. */
	skipRefresh?: boolean;
}

export interface CodeSearchOptions extends CodeQueryOptions {
	regex?: boolean;
	ignoreCase?: boolean;
}

interface IndexedFile {
	path: string;
	language: string;
	size: number;
	mtimeMs: number;
	hash: string;
	symbols: IndexedCodeSymbol[];
	updatedAt: number;
}

interface PersistedCodeIndex {
	version: 2;
	root: string;
	updatedAt: number;
	files: Record<string, IndexedFile>;
}

interface DiscoveredFile {
	absPath: string;
	relPath: string;
	size: number;
	mtimeMs: number;
}

interface FileDiscoveryResult {
	files: DiscoveredFile[];
	limitReached: boolean;
	incomplete: boolean;
}

// Bump when parser or masking behavior changes so stale symbol data is rebuilt.
const INDEX_VERSION = 2 as const;
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 50_000_000;
const DEFAULT_QUERY_LIMIT = 100;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".c": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".cs": "csharp",
	".go": "go",
	".h": "c",
	".hpp": "cpp",
	".java": "java",
	".js": "javascript",
	".jsx": "javascript",
	".json": "json",
	".kt": "kotlin",
	".kts": "kotlin",
	".mjs": "javascript",
	".php": "php",
	".py": "python",
	".rb": "ruby",
	".rs": "rust",
	".scss": "scss",
	".sh": "shell",
	".sql": "sql",
	".swift": "swift",
	".svelte": "svelte",
	".ts": "typescript",
	".tsx": "typescript",
	".vue": "vue",
	".xml": "xml",
	".yaml": "yaml",
	".yml": "yaml",
};

const IGNORED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"coverage",
	"out",
	"target",
	".next",
	".turbo",
	"vendor",
]);

const SENSITIVE_FILE_NAMES = new Set([
	".env",
	".env.local",
	".env.development",
	".env.production",
	"auth.json",
	"credentials.json",
	"secrets.json",
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
]);

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	throwIfAborted(signal);
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new Error("Operation aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function isInside(root: string, target: string): boolean {
	return isInsideWorkspace(root, target);
}

function pathFilterMatches(root: string, filePath: string, pathFilter: string | undefined): boolean {
	if (!pathFilter) return true;
	return isInsideWorkspace(normalizeDocumentPath(pathFilter, root), normalizeDocumentPath(filePath, root));
}

function hashText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function lineNumberAt(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index++) {
		if (text.charCodeAt(index) === 10) line++;
	}
	return line;
}

function lineTextAt(text: string, line: number): string {
	return text.split(/\r?\n/)[line - 1]?.trim() ?? "";
}

function signatureForLine(text: string, line: number): string {
	const value = sanitizeSignature(lineTextAt(text, line).replace(/\s+/g, " ").trim());
	return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}

function sanitizeSignature(value: string): string {
	return value
		.replace(
			/((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|private[_-]?key|client[_-]?secret|token|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
			"$1[redacted]",
		)
		.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\b(?:sk|pk|ghp|github_pat|AIza)[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
		.replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "[redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
		.replace(/-----BEGIN [^-]+-----.*$/g, "[redacted private key]")
		.replace(/-----END [^-]+-----.*$/g, "[redacted private key]");
}

function endLineForDeclaration(maskedText: string, startOffset: number, startLine: number): number {
	const openingBrace = maskedText.indexOf("{", startOffset);
	if (openingBrace < 0 || openingBrace - startOffset > 400) return startLine;

	let depth = 0;
	for (let index = openingBrace; index < maskedText.length; index++) {
		const char = maskedText[index];
		if (char === "{") depth++;
		if (char === "}") {
			depth--;
			if (depth === 0) return lineNumberAt(maskedText, index);
		}
	}
	return startLine;
}

/** Replace comments and string contents while preserving offsets and line breaks. */
function maskNonCode(text: string, language: string): string {
	// Use UTF-16 code units so indexes stay aligned with JavaScript string offsets.
	const masked = text.split("");
	const hashComments = new Set(["python", "ruby", "shell", "yaml", "json", "scss", "svelte", "vue"]);
	const slashComments = new Set([
		"javascript",
		"typescript",
		"java",
		"kotlin",
		"csharp",
		"c",
		"cpp",
		"go",
		"rust",
		"swift",
		"php",
		"scss",
		"svelte",
		"vue",
	]);
	const regexLanguages = new Set([
		"javascript",
		"typescript",
		"java",
		"kotlin",
		"csharp",
		"c",
		"cpp",
		"go",
		"rust",
		"swift",
		"php",
	]);
	const sqlComments = language === "sql";
	let state: "code" | "line-comment" | "block-comment" | "string" | "regex" = "code";
	let quote = "";
	let tripleQuote = false;
	let regexInCharacterClass = false;
	let previousCodeChar = "";
	let lineStart = true;
	const canStartRegex = (index: number): boolean => {
		if (!previousCodeChar || /[([{:;,=!?&|+\-*%^~<>]/.test(previousCodeChar)) return true;
		let tokenStart = index;
		while (tokenStart > 0 && /[A-Za-z0-9_$]/.test(text[tokenStart - 1] ?? "")) tokenStart--;
		const previousToken = text.slice(tokenStart, index);
		return [
			"case",
			"delete",
			"do",
			"else",
			"in",
			"instanceof",
			"of",
			"return",
			"throw",
			"typeof",
			"void",
			"yield",
		].includes(previousToken);
	};

	const blank = (index: number): void => {
		if (index < 0 || index >= masked.length) return;
		if (masked[index] !== "\r" && masked[index] !== "\n") masked[index] = " ";
	};

	for (let index = 0; index < text.length; index++) {
		const current = text[index];
		const next = text[index + 1];
		if (state === "line-comment") {
			blank(index);
			if (current === "\n") {
				state = "code";
				lineStart = true;
			}
			continue;
		}
		if (state === "block-comment") {
			blank(index);
			if (current === "*" && next === "/") {
				blank(index + 1);
				index++;
				state = "code";
			}
			if (current === "\n") lineStart = true;
			continue;
		}
		if (state === "string") {
			blank(index);
			if (current === "\\") {
				blank(index + 1);
				index++;
				continue;
			}
			if (tripleQuote ? text.startsWith(quote.repeat(3), index) : current === quote) {
				if (tripleQuote) {
					blank(index + 1);
					blank(index + 2);
					index += 2;
				}
				state = "code";
				previousCodeChar = quote;
				quote = "";
				tripleQuote = false;
			}
			if (current === "\n") lineStart = true;
			continue;
		}
		if (state === "regex") {
			blank(index);
			if (current === "\\") {
				blank(index + 1);
				index++;
				continue;
			}
			if (current === "[") {
				regexInCharacterClass = true;
				continue;
			}
			if (current === "]") {
				regexInCharacterClass = false;
				continue;
			}
			if (current === "/" && !regexInCharacterClass) {
				state = "code";
				previousCodeChar = "/";
			}
			if (current === "\n") lineStart = true;
			continue;
		}

		if (current === "\n") {
			lineStart = true;
			continue;
		}
		const atLineStart = lineStart;
		if (current !== " " && current !== "\t" && current !== "\r") lineStart = false;
		if (current === "/" && next === "*") {
			blank(index);
			blank(index + 1);
			index++;
			state = "block-comment";
			continue;
		}
		if (slashComments.has(language) && current === "/" && next === "/") {
			blank(index);
			blank(index + 1);
			index++;
			state = "line-comment";
			continue;
		}
		if (regexLanguages.has(language) && current === "/" && canStartRegex(index)) {
			blank(index);
			state = "regex";
			regexInCharacterClass = false;
			continue;
		}
		if (sqlComments && current === "-" && next === "-") {
			blank(index);
			blank(index + 1);
			index++;
			state = "line-comment";
			continue;
		}
		if (hashComments.has(language) && current === "#" && (atLineStart || /\s/.test(text[index - 1] ?? ""))) {
			blank(index);
			state = "line-comment";
			continue;
		}
		if (current === "'" || current === '"' || current === "`") {
			quote = current;
			tripleQuote = (language === "python" || language === "ruby") && text.startsWith(current.repeat(3), index);
			blank(index);
			if (tripleQuote) {
				blank(index + 1);
				blank(index + 2);
				index += 2;
			}
			state = "string";
			continue;
		}
		if (!/\s/.test(current)) previousCodeChar = current;
	}
	return masked.join("");
}

function isExported(line: string): boolean {
	return /^\s*export\b/.test(line) || /^\s*pub\b/.test(line);
}

function parserKindForDeclaration(kind: string): IndexedCodeSymbolKind {
	if (kind === "struct") return "struct";
	if (kind === "trait") return "trait";
	if (kind === "namespace") return "namespace";
	if (kind === "module") return "module";
	return kind as IndexedCodeSymbolKind;
}

const CODE_IDENTIFIER = String.raw`[\p{ID_Start}_$][\p{ID_Continue}$]*`;
const PYTHON_IDENTIFIER = String.raw`[\p{ID_Start}_][\p{ID_Continue}]*`;
const GO_IDENTIFIER = String.raw`[\p{L}_][\p{L}\p{N}_]*`;

/**
 * Extract symbols without requiring a language server or a runtime compiler.
 * The parser is intentionally conservative: false positives are worse than
 * falling back to grep, so unsupported syntax simply produces fewer symbols.
 */
export function parseCodeSymbols(
	content: string,
	language: string,
	filePath: string,
	hash = hashText(content),
): IndexedCodeSymbol[] {
	const masked = maskNonCode(content, language);
	const symbols: IndexedCodeSymbol[] = [];
	const seen = new Set<string>();
	const add = (kind: IndexedCodeSymbolKind, name: string, offset: number, exported: boolean): void => {
		const line = lineNumberAt(masked, offset);
		const key = `${kind}:${name}:${line}`;
		if (seen.has(key)) return;
		seen.add(key);
		symbols.push({
			id: `${filePath}:${kind}:${name}:${line}`,
			path: filePath,
			language,
			kind,
			name,
			line,
			endLine: endLineForDeclaration(masked, offset, line),
			signature: signatureForLine(content, line),
			exported,
			hash,
			updatedAt: Date.now(),
		});
	};

	const declarations = new RegExp(
		String.raw`^[ \t]*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|interface|type|enum|namespace|module|struct|trait)\s+(${CODE_IDENTIFIER})`,
		"gmu",
	);
	for (const match of masked.matchAll(declarations)) {
		const offset = match.index ?? 0;
		if (language === "go" && match[2] === "type") continue;
		add(
			parserKindForDeclaration(match[2]),
			match[3],
			offset,
			Boolean(match[1]) || isExported(lineTextAt(content, lineNumberAt(masked, offset))),
		);
	}

	const functions = new RegExp(
		String.raw`^[ \t]*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s+(${CODE_IDENTIFIER})`,
		"gmu",
	);
	for (const match of masked.matchAll(functions)) {
		const offset = match.index ?? 0;
		add(
			"function",
			match[2],
			offset,
			Boolean(match[1]) || isExported(lineTextAt(content, lineNumberAt(masked, offset))),
		);
	}

	const methods = new RegExp(
		String.raw`^[ \t]*(?:(?:public|private|protected|internal|static|abstract|override|virtual|final|async)\s+)*(${CODE_IDENTIFIER})\s*\([^;\n]*\)\s*\{`,
		"gmu",
	);
	for (const match of masked.matchAll(methods)) {
		const offset = match.index ?? 0;
		const line = lineTextAt(content, lineNumberAt(masked, offset));
		if (/\b(function|if|for|while|switch|catch)\b/.test(line)) continue;
		if (symbols.some((symbol) => symbol.name === match[1] && symbol.line === lineNumberAt(masked, offset))) continue;
		add("method", match[1], offset, isExported(line));
	}

	const arrows = new RegExp(
		String.raw`^[ \t]*(export\s+)?(?:const|let|var)\s+(${CODE_IDENTIFIER})\s*=\s*(?:async\s*)?(?:\([^=\n]*\)|${CODE_IDENTIFIER})\s*=>`,
		"gmu",
	);
	const arrowLines = new Set<number>();
	for (const match of masked.matchAll(arrows)) {
		const offset = match.index ?? 0;
		const line = lineNumberAt(masked, offset);
		arrowLines.add(line);
		add("function", match[2], offset, Boolean(match[1]) || isExported(lineTextAt(content, line)));
	}

	const variables = new RegExp(
		String.raw`^[ \t]*(export\s+)?(const|let|var)\s+(${CODE_IDENTIFIER})(?=\s|[=;,:]|$)`,
		"gmu",
	);
	for (const match of masked.matchAll(variables)) {
		const offset = match.index ?? 0;
		const line = lineNumberAt(masked, offset);
		if (arrowLines.has(line)) continue;
		add(
			match[2] === "const" ? "constant" : "variable",
			match[3],
			offset,
			Boolean(match[1]) || isExported(lineTextAt(content, line)),
		);
	}

	const pythonDefinitions = new RegExp(String.raw`^[ \t]*(?:async\s+)?def\s+(${PYTHON_IDENTIFIER})`, "gmu");
	for (const match of masked.matchAll(pythonDefinitions)) add("function", match[1], match.index ?? 0, false);
	const pythonClasses = new RegExp(String.raw`^[ \t]*class\s+(${PYTHON_IDENTIFIER})`, "gmu");
	for (const match of masked.matchAll(pythonClasses)) add("class", match[1], match.index ?? 0, false);

	const goFunctions = new RegExp(String.raw`^[ \t]*func\s+(?:\([^)]*\)\s*)?(${GO_IDENTIFIER})`, "gmu");
	for (const match of masked.matchAll(goFunctions))
		add("function", match[1], match.index ?? 0, isGoExported(match[1]));
	const goTypes = new RegExp(String.raw`^[ \t]*type\s+(${GO_IDENTIFIER})(?:\s+(struct|interface))?`, "gmu");
	for (const match of masked.matchAll(goTypes))
		add(
			match[2] === "struct" ? "struct" : match[2] === "interface" ? "interface" : "type",
			match[1],
			match.index ?? 0,
			isGoExported(match[1]),
		);

	const rustFunctions = new RegExp(String.raw`^[ \t]*(?:pub\s+)?(?:async\s+)?fn\s+(${PYTHON_IDENTIFIER})`, "gmu");
	for (const match of masked.matchAll(rustFunctions))
		add(
			"function",
			match[1],
			match.index ?? 0,
			/^\s*pub\b/.test(lineTextAt(content, lineNumberAt(masked, match.index ?? 0))),
		);

	const exports = /\bexport\s*\{([^}]+)\}/g;
	const exportedNames = new Set<string>();
	for (const match of masked.matchAll(exports)) {
		for (const entry of match[1].split(",")) {
			const name = entry.trim().split(/\s+as\s+/i)[0];
			if (new RegExp(`^${CODE_IDENTIFIER}$`, "u").test(name)) exportedNames.add(name);
		}
	}
	for (const symbol of symbols) {
		if (exportedNames.has(symbol.name)) symbol.exported = true;
	}

	const containers = symbols.filter((symbol) =>
		["class", "interface", "namespace", "module", "struct", "trait"].includes(symbol.kind),
	);
	for (const symbol of symbols) {
		const parent = containers
			.filter(
				(candidate) =>
					candidate.id !== symbol.id && candidate.line <= symbol.line && candidate.endLine >= symbol.line,
			)
			.sort((left, right) => right.line - left.line)[0];
		if (parent) symbol.parentName = parent.name;
	}

	return symbols.sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
}

export function getCodeLanguage(filePath: string): string | undefined {
	return LANGUAGE_BY_EXTENSION[windowsPath.extname(filePath).toLowerCase()];
}

export function getCodeIndexPath(cwd: string, agentDir = getAgentDir()): string {
	const root = normalizeWorkspaceRoot(cwd);
	const key = hashText(getWorkspaceIdentity(root)).slice(0, 32);
	return windowsPath.join(windowsPath.resolve(agentDir), "code-index", key, "index.json");
}

function isSensitivePath(relativePath: string): boolean {
	const name = windowsPath.basename(relativePath).toLowerCase();
	if (SENSITIVE_FILE_NAMES.has(name)) return true;
	if (name.startsWith(".env.")) return true;
	return /\.(pem|key|p12|pfx|jks|keystore)$/i.test(name);
}

async function readIgnoreMatcher(root: string): Promise<ReturnType<typeof ignore>> {
	const matcher = ignore({ allowRelativePaths: true });
	matcher.add([...IGNORED_DIRECTORIES].map((directory) => `${directory}/`));
	try {
		const gitignore = await readFile(windowsPath.join(root, ".gitignore"), "utf8");
		matcher.add(gitignore.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#")));
	} catch {}
	return matcher;
}

async function discoverFiles(
	root: string,
	matcher: ReturnType<typeof ignore>,
	maxFiles: number,
	excludedDirectory: string,
	signal?: AbortSignal,
): Promise<FileDiscoveryResult> {
	const result: DiscoveredFile[] = [];
	let limitReached = false;
	let incomplete = false;
	const walk = async (directory: string): Promise<void> => {
		throwIfAborted(signal);
		if (result.length >= maxFiles) {
			limitReached = true;
			return;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			incomplete = true;
			return;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			throwIfAborted(signal);
			if (result.length >= maxFiles) {
				limitReached = true;
				return;
			}
			const absPath = windowsPath.join(directory, entry.name);
			if (isInside(excludedDirectory, absPath)) continue;
			const relPath = relativeToWorkspace(root, absPath);
			if (!relPath || isSensitivePath(relPath)) continue;
			if (entry.isDirectory()) {
				if (IGNORED_DIRECTORIES.has(entry.name) || matcher.ignores(`${relPath}/`)) continue;
				await walk(absPath);
				continue;
			}
			if (!entry.isFile() || matcher.ignores(relPath)) continue;
			const language = getCodeLanguage(relPath);
			if (!language) continue;
			try {
				const fileStat = await stat(absPath);
				result.push({ absPath, relPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
			} catch {
				incomplete = true;
			}
		}
	};
	await walk(root);
	return { files: result, limitReached, incomplete };
}

export class CodeSymbolIndex {
	private readonly root: string;
	private readonly storagePath: string;
	private readonly maxFiles: number;
	private readonly maxFileBytes: number;
	private readonly maxTotalBytes: number;
	private files = new Map<string, IndexedFile>();
	private loaded = false;
	private refreshPromise?: Promise<CodeIndexRefreshSummary>;
	private refreshQueue: Promise<void> = Promise.resolve();
	private lastUpdated?: number;
	private lastRefreshSummary?: CodeIndexRefreshSummary;

	constructor(options: CodeIndexOptions) {
		this.root = normalizeWorkspaceRoot(options.cwd);
		this.storagePath = getCodeIndexPath(this.root, options.agentDir ?? getAgentDir());
		this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
		this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
		this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	}

	getRoot(): string {
		return this.root;
	}

	getStats(): CodeIndexStats {
		return {
			fileCount: this.files.size,
			symbolCount: [...this.files.values()].reduce((total, file) => total + file.symbols.length, 0),
			lastUpdated: this.lastUpdated,
			storagePath: this.storagePath,
		};
	}

	async ensureFresh(signal?: AbortSignal): Promise<CodeIndexRefreshSummary> {
		throwIfAborted(signal);
		if (!this.refreshPromise) {
			const refresh = this.enqueueRefresh();
			this.refreshPromise = refresh
				.then((summary) => {
					this.lastRefreshSummary = summary;
					return summary;
				})
				.finally(() => {
					this.refreshPromise = undefined;
				});
		}
		return await waitForAbort(this.refreshPromise, signal);
	}

	async rebuild(signal?: AbortSignal): Promise<CodeIndexRefreshSummary> {
		throwIfAborted(signal);
		const refresh = this.enqueueRefresh(true);
		const summary = await waitForAbort(refresh, signal);
		this.lastRefreshSummary = summary;
		return summary;
	}

	getLastRefreshSummary(): CodeIndexRefreshSummary | undefined {
		return this.lastRefreshSummary;
	}

	private enqueueRefresh(rebuild = false): Promise<CodeIndexRefreshSummary> {
		const refresh = this.refreshQueue.then(async () => {
			if (rebuild) {
				this.files.clear();
				this.loaded = true;
			}
			return this.refresh();
		});
		this.refreshQueue = refresh.then(
			() => undefined,
			() => undefined,
		);
		return refresh;
	}

	private async loadPersisted(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed = JSON.parse(await readFile(this.storagePath, "utf8")) as PersistedCodeIndex;
			if (
				parsed.version !== INDEX_VERSION ||
				getWorkspaceIdentity(parsed.root) !== getWorkspaceIdentity(this.root) ||
				!parsed.files
			)
				return;
			this.files = new Map(Object.entries(parsed.files));
			this.lastUpdated = parsed.updatedAt;
		} catch {}
	}

	private async persist(): Promise<void> {
		const directory = windowsPath.dirname(this.storagePath);
		await mkdir(directory, { recursive: true });
		const payload: PersistedCodeIndex = {
			version: INDEX_VERSION,
			root: this.root,
			updatedAt: this.lastUpdated ?? Date.now(),
			files: Object.fromEntries(this.files),
		};
		const temporaryPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporaryPath, JSON.stringify(payload), "utf8");
		await rename(temporaryPath, this.storagePath);
	}

	private async refresh(signal?: AbortSignal): Promise<CodeIndexRefreshSummary> {
		await this.loadPersisted();
		throwIfAborted(signal);
		const matcher = await readIgnoreMatcher(this.root);
		const agentStorageRoot = windowsPath.dirname(windowsPath.dirname(windowsPath.dirname(this.storagePath)));
		const discovery = await discoverFiles(this.root, matcher, this.maxFiles, agentStorageRoot, signal);
		const discovered = discovery.files;
		const nextFiles = new Map<string, IndexedFile>();
		let added = 0;
		let updated = 0;
		let unchanged = 0;
		let skipped = 0;
		let limitSkipped = 0;
		let scanIncomplete = discovery.incomplete;
		let totalBytes = 0;

		for (const file of discovered) {
			throwIfAborted(signal);
			const previous = this.files.get(file.relPath);
			const language = getCodeLanguage(file.relPath);
			if (!language || file.size > this.maxFileBytes || totalBytes + file.size > this.maxTotalBytes) {
				skipped++;
				limitSkipped++;
				if (previous) nextFiles.set(file.relPath, previous);
				continue;
			}
			totalBytes += file.size;

			let content: string;
			try {
				content = await readFile(file.absPath, "utf8");
			} catch {
				skipped++;
				scanIncomplete = true;
				if (previous) nextFiles.set(file.relPath, previous);
				continue;
			}
			const hash = hashText(content);
			if (previous && previous.hash === hash && previous.language === language) {
				nextFiles.set(file.relPath, { ...previous, size: file.size, mtimeMs: file.mtimeMs });
				unchanged++;
				continue;
			}
			let symbols: IndexedCodeSymbol[] = [];
			try {
				symbols = parseCodeSymbols(content, language, file.relPath, hash);
			} catch {
				// A parser failure must not make the index unusable. The file remains
				// searchable through searchCode(), which is the documented fallback.
				symbols = [];
			}
			nextFiles.set(file.relPath, {
				path: file.relPath,
				language,
				size: file.size,
				mtimeMs: file.mtimeMs,
				hash,
				symbols,
				updatedAt: Date.now(),
			});
			if (previous) updated++;
			else added++;
		}

		const incomplete = discovery.limitReached || scanIncomplete;
		if (incomplete) {
			for (const [filePath, previous] of this.files) {
				if (!nextFiles.has(filePath)) nextFiles.set(filePath, previous);
			}
		}
		const removed = incomplete ? 0 : [...this.files.keys()].filter((filePath) => !nextFiles.has(filePath)).length;
		this.files = nextFiles;
		this.lastUpdated = Date.now();
		if (added || updated || removed || skipped || !this.loaded) {
			try {
				await this.persist();
			} catch {
				// Queries remain usable if the user data directory is temporarily unavailable.
			}
		}
		return {
			added,
			updated,
			removed,
			unchanged,
			skipped,
			limited: incomplete || limitSkipped > 0,
			fileCount: this.files.size,
			symbolCount: [...this.files.values()].reduce((total, file) => total + file.symbols.length, 0),
		};
	}

	private resolveQueryPath(pathValue?: string): string | undefined {
		if (!pathValue) return undefined;
		const absolute = normalizeDocumentPath(pathValue, this.root);
		if (!isInside(this.root, absolute)) throw new Error("查询路径必须位于当前项目目录内");
		return relativeToWorkspace(this.root, absolute);
	}

	async findSymbol(name: string, options: CodeQueryOptions = {}): Promise<IndexedCodeSymbol[]> {
		if (!options.skipRefresh) await this.ensureFresh(options.signal);
		throwIfAborted(options.signal);
		const query = name.trim().toLowerCase();
		if (!query) return [];
		const pathFilter = this.resolveQueryPath(options.path);
		const limit = Math.max(1, options.limit ?? DEFAULT_QUERY_LIMIT);
		return [...this.files.values()]
			.filter((file) => pathFilterMatches(this.root, file.path, pathFilter))
			.flatMap((file) => file.symbols)
			.filter((symbol) => symbol.name.toLowerCase().includes(query))
			.slice(0, limit);
	}

	async findDefinition(name: string, options: CodeQueryOptions = {}): Promise<IndexedCodeSymbol[]> {
		if (!options.skipRefresh) await this.ensureFresh(options.signal);
		throwIfAborted(options.signal);
		const query = name.trim();
		if (!query) return [];
		const pathFilter = this.resolveQueryPath(options.path);
		const limit = Math.max(1, options.limit ?? DEFAULT_QUERY_LIMIT);
		return [...this.files.values()]
			.filter((file) => pathFilterMatches(this.root, file.path, pathFilter))
			.flatMap((file) => file.symbols)
			.filter((symbol) => symbol.name === query)
			.slice(0, limit);
	}

	async listFileSymbols(pathValue: string, options: CodeQueryOptions = {}): Promise<IndexedCodeSymbol[]> {
		if (!options.skipRefresh) await this.ensureFresh(options.signal);
		throwIfAborted(options.signal);
		const pathFilter = this.resolveQueryPath(pathValue);
		if (!pathFilter) return [];
		const limit = Math.max(1, options.limit ?? 500);
		return [...this.files.values()]
			.filter((file) => pathFilterMatches(this.root, file.path, pathFilter))
			.flatMap((file) => file.symbols)
			.slice(0, limit);
	}

	async findReferences(name: string, options: CodeQueryOptions = {}): Promise<IndexedCodeReference[]> {
		if (!options.skipRefresh) await this.ensureFresh(options.signal);
		throwIfAborted(options.signal);
		const query = name.trim();
		if (!query) return [];
		const pathFilter = this.resolveQueryPath(options.path);
		const limit = Math.max(1, options.limit ?? DEFAULT_QUERY_LIMIT);
		const references: IndexedCodeReference[] = [];
		for (const file of this.files.values()) {
			if (!pathFilterMatches(this.root, file.path, pathFilter)) continue;
			throwIfAborted(options.signal);
			let content: string;
			try {
				content = await readFile(windowsPath.join(this.root, file.path), "utf8");
			} catch {
				continue;
			}
			const lines = content.split(/\r?\n/);
			const maskedLines = maskNonCode(content, file.language).split(/\r?\n/);
			for (let index = 0; index < lines.length && references.length < limit; index++) {
				if (!hasIdentifierReference(maskedLines[index], query)) continue;
				const symbol = file.symbols.find((candidate) => candidate.name === query && candidate.line === index + 1);
				references.push({
					source: file.path,
					target: query,
					path: file.path,
					line: index + 1,
					text: sanitizeSignature(lines[index].trim()),
					referenceKind: symbol ? "definition" : "reference",
				});
			}
			if (references.length >= limit) break;
		}
		return references;
	}

	async searchCode(pattern: string, options: CodeSearchOptions = {}): Promise<CodeSearchMatch[]> {
		if (!options.skipRefresh) await this.ensureFresh(options.signal);
		throwIfAborted(options.signal);
		if (!pattern) return [];
		const pathFilter = this.resolveQueryPath(options.path);
		const limit = Math.max(1, options.limit ?? DEFAULT_QUERY_LIMIT);
		const matcher = createSearchMatcher(pattern, options.regex, options.ignoreCase);
		const results: CodeSearchMatch[] = [];
		for (const file of this.files.values()) {
			if (!pathFilterMatches(this.root, file.path, pathFilter)) continue;
			throwIfAborted(options.signal);
			let content: string;
			try {
				content = await readFile(windowsPath.join(this.root, file.path), "utf8");
			} catch {
				continue;
			}
			for (const [index, line] of content.split(/\r?\n/).entries()) {
				if (matcher.test(line)) {
					results.push({ path: file.path, line: index + 1, text: sanitizeSignature(line.trim()) });
					if (results.length >= limit) return results;
				}
				matcher.lastIndex = 0;
			}
		}
		return results;
	}

	async getCodeMap(pathValue?: string, options: CodeQueryOptions = {}): Promise<CodeMapEntry[]> {
		if (!options.skipRefresh) await this.ensureFresh(options.signal);
		throwIfAborted(options.signal);
		const pathFilter = this.resolveQueryPath(pathValue);
		const limit = Math.max(1, options.limit ?? 500);
		return [...this.files.values()]
			.filter((file) => pathFilterMatches(this.root, file.path, pathFilter))
			.map((file) => ({ path: file.path, language: file.language, symbols: file.symbols }))
			.filter((entry) => entry.symbols.length > 0)
			.slice(0, limit);
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGoExported(name: string): boolean {
	return /^\p{Lu}/u.test(name);
}

function isIdentifierCharacter(value: string | undefined): boolean {
	return value !== undefined && /^[\p{L}\p{N}_$]$/u.test(value);
}

function hasIdentifierReference(line: string, query: string): boolean {
	let offset = 0;
	while (offset <= line.length - query.length) {
		const index = line.indexOf(query, offset);
		if (index < 0) return false;
		const before = line[index - 1];
		const after = line[index + query.length];
		if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after)) return true;
		offset = index + Math.max(query.length, 1);
	}
	return false;
}

const MAX_SEARCH_REGEX_LENGTH = 256;

function createSearchMatcher(pattern: string, regex: boolean | undefined, ignoreCase: boolean | undefined): RegExp {
	if (!regex) return new RegExp(escapeRegExp(pattern), ignoreCase ? "gi" : "g");
	if (pattern.length > MAX_SEARCH_REGEX_LENGTH) {
		throw new Error(`正则搜索表达式不能超过 ${MAX_SEARCH_REGEX_LENGTH} 个字符`);
	}
	if (/\\(?:[1-9]|k<)|\([^()]*[*+{][^()]*\)[*+{]/.test(pattern)) {
		throw new Error("正则搜索表达式包含可能导致长时间阻塞的结构");
	}
	try {
		return new RegExp(pattern, ignoreCase ? "gi" : "g");
	} catch (error) {
		throw new Error(`无效的搜索表达式：${error instanceof Error ? error.message : String(error)}`);
	}
}
