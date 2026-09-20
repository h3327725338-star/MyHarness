/**
 * Core File Presentation service (Task 9).
 *
 * Hosts (Desktop) preview files through this single Core capability instead of
 * touching the filesystem directly. Path resolution, existence checks, binary
 * detection, line/byte limits and structured truncation all live here and
 * mirror the Read tool's semantics (`resolveToCwd` + `DEFAULT_MAX_LINES` /
 * `DEFAULT_MAX_BYTES`) so the Desktop never gets a second, divergent file
 * access policy.
 *
 * This module only returns serialization-safe facts (path, lines, sizes,
 * hashes). It never returns markup, ANSI, or rendered content.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { resolveToCwd } from "../tools/path-utils.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "../tools/truncate.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../utils/paths.ts";

/** Hard cap on previewed file size. Larger files are refused (not loaded). */
export const MAX_PREVIEW_FILE_BYTES = 64 * 1024 * 1024;
/** Bytes sniffed for binary detection (NUL byte in the head = binary). */
export const BINARY_SNIFF_BYTES = 8 * 1024;

export type FilePreviewErrorCode =
	| "not_found"
	| "not_file"
	| "binary"
	| "too_large"
	| "invalid_range"
	| "permission_denied"
	| "internal";

export interface FilePreviewLine {
	/** Real 1-based file line number. */
	lineNumber: number;
	/** Line text without the trailing `\r` (CRLF files map 1:1 by `\n`). */
	text: string;
}

export interface FilePreviewTruncation {
	truncatedBy: "lines" | "bytes" | null;
	/** Total lines in the whole file. */
	totalLines: number;
	/** Total bytes of the whole file. */
	totalBytes: number;
	/** Lines actually returned (after truncation). */
	shownLines: number;
	/** Bytes of the returned content text. */
	shownBytes: number;
	maxLines: number;
	maxBytes: number;
	/** First line alone exceeded the byte limit (no content returned). */
	firstLineExceedsLimit: boolean;
}

export type FilePreviewKind = "text" | "binary" | "empty";

export interface FilePreview {
	/** Path as provided by the host. */
	path: string;
	/** Absolute resolved path (same resolution semantics as the Read tool). */
	resolvedPath: string;
	/** Relative-to-cwd path when inside cwd, absolute otherwise. */
	displayPath: string;
	/** cwd used for resolution (workspace identity). */
	cwd: string;
	kind: FilePreviewKind;
	/** Language hint by extension when known. */
	language?: string;
	/** The Core only reads files as UTF-8. */
	encoding: "utf-8";
	/** File size in bytes on disk. */
	size: number;
	/** Binary type hint (e.g. "PNG image"), binary files only. */
	typeHint?: string;
	/** Total line count (0 for binary/empty). */
	lineCount: number;
	/** Requested window (subject to truncation limits). */
	lines: FilePreviewLine[];
	/** 1-based first shown line (undefined for binary/empty). */
	shownStartLine?: number;
	/** 1-based last shown line (undefined for binary/empty). */
	shownEndLine?: number;
	/** Exact model-visible text of the shown lines (LF-joined, trailing CR stripped). */
	contentText: string;
	/** sha256 of `contentText`; used for context snapshot provenance. */
	contentHash: string;
	truncated: boolean;
	truncation?: FilePreviewTruncation;
	/** Binary files only: human-readable "Preview not available" note. */
	binaryNote?: string;
	/** Epoch ms when the snapshot was produced. */
	snapshotAt: number;
}

export type FilePreviewResult =
	| { ok: true; preview: FilePreview }
	| { ok: false; code: FilePreviewErrorCode; message: string };

export interface FilePreviewParams {
	path: string;
	cwd: string;
	/** 1-based inclusive; omitted = whole file. */
	startLine?: number;
	endLine?: number;
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

const BINARY_TYPE_HINTS: Record<string, string> = {
	png: "PNG image",
	jpg: "JPEG image",
	jpeg: "JPEG image",
	gif: "GIF image",
	webp: "WebP image",
	bmp: "BMP image",
	svg: "SVG image",
	ico: "ICO image",
	tiff: "TIFF image",
	pdf: "PDF document",
	exe: "Windows executable",
	dll: "Windows DLL",
	so: "Shared library",
	dylib: "macOS library",
	zip: "ZIP archive",
	rar: "RAR archive",
	"7z": "7-Zip archive",
	tar: "TAR archive",
	gz: "GZIP archive",
	doc: "Word document",
	docx: "Word document",
	xls: "Excel spreadsheet",
	xlsx: "Excel spreadsheet",
	ppt: "PowerPoint presentation",
	pptx: "PowerPoint presentation",
	db: "Database file",
	sqlite: "SQLite database",
	class: "Java class file",
	woff: "Web font",
	woff2: "Web font",
	ttf: "TrueType font",
	otf: "OpenType font",
	mp3: "MP3 audio",
	mp4: "MP4 video",
	wasm: "WebAssembly binary",
};

/** True when the head of the buffer contains NUL bytes (not valid UTF-8 text). */
export function isBinaryBuffer(buffer: Buffer): boolean {
	const head = buffer.subarray(0, BINARY_SNIFF_BYTES);
	return head.includes(0);
}

function typeHintForPath(path: string): string | undefined {
	const ext = path.split(".").pop()?.toLowerCase();
	return ext ? BINARY_TYPE_HINTS[ext] : undefined;
}

// ---------------------------------------------------------------------------
// Line reader (shared by preview and context snapshot validation)
// ---------------------------------------------------------------------------

export interface ReadFileLinesResult {
	ok: true;
	resolvedPath: string;
	/** 1-based window lines (subject to truncation limits). */
	lines: FilePreviewLine[];
	/** Total lines in the whole file. */
	totalLines: number;
	/** Total bytes of the whole file. */
	totalBytes: number;
	/** Exact model-visible text of the returned lines. */
	contentText: string;
	contentHash: string;
	truncated: boolean;
	truncation?: FilePreviewTruncation;
}

export type ReadFileLinesOutcome = ReadFileLinesResult | { ok: false; code: FilePreviewErrorCode; message: string };

function languageForPath(path: string): string | undefined {
	const ext = path.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		mts: "typescript",
		cts: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		kts: "kotlin",
		c: "c",
		h: "c",
		cc: "cpp",
		cpp: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		swift: "swift",
		scala: "scala",
		sh: "shell",
		bash: "shell",
		zsh: "shell",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		css: "css",
		scss: "scss",
		less: "less",
		json: "json",
		jsonc: "json",
		md: "markdown",
		markdown: "markdown",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		svg: "svg",
		ini: "ini",
		cfg: "ini",
		conf: "conf",
		log: "log",
		txt: "text",
		gitignore: "gitignore",
		editorconfig: "editorconfig",
		env: "dotenv",
	};
	return map[ext];
}

/**
 * Read a file as UTF-8 text with a bounded streaming line model.
 *
 * - Resolves the path exactly like the Read tool (`resolveToCwd`).
 * - Refuses directories, missing files, permission failures and files above
 *   `MAX_PREVIEW_FILE_BYTES`.
 * - Detects binary files by NUL bytes in the head.
 * - Splits on `\n` only (CRLF files map 1:1; the trailing `\r` is stripped
 *   per line for display). Line numbers are real file line numbers.
 * - Applies the Read tool's shared limits (2000 lines / 50KB) to the requested
 *   window and reports truncation structurally.
 */
export async function previewFile(params: FilePreviewParams): Promise<ReadFileLinesOutcome> {
	const { path, cwd } = params;
	const resolvedPath = resolveToCwd(path, cwd);
	try {
		const fileStat = await stat(resolvedPath);
		if (fileStat.isDirectory()) {
			return {
				ok: false,
				code: "not_file",
				message: `Is a directory: ${formatPathRelativeToCwdOrAbsolute(resolvedPath, cwd)}`,
			};
		}
		if (fileStat.size > MAX_PREVIEW_FILE_BYTES) {
			return {
				ok: false,
				code: "too_large",
				message: `File is too large to preview (${formatSize(fileStat.size)} exceeds the ${formatSize(MAX_PREVIEW_FILE_BYTES)} limit).`,
			};
		}

		// Binary sniff: NUL bytes in the head => binary.
		const fd = await open(resolvedPath, "r");
		try {
			const sniff = Buffer.allocUnsafe(Math.min(BINARY_SNIFF_BYTES, fileStat.size || 1));
			const { bytesRead } = await fd.read(sniff, 0, sniff.length, 0);
			if (bytesRead > 0 && isBinaryBuffer(sniff.subarray(0, bytesRead))) {
				return { ok: false, code: "binary", message: "Binary file" };
			}
		} finally {
			await fd.close();
		}

		return await readTextLines(resolvedPath, params);
	} catch (error: unknown) {
		return mapFileError(error, resolvedPath, cwd);
	}
}

function mapFileError(
	error: unknown,
	resolvedPath: string,
	cwd: string,
): { ok: false; code: FilePreviewErrorCode; message: string } {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT") {
		return {
			ok: false,
			code: "not_found",
			message: `File not found: ${formatPathRelativeToCwdOrAbsolute(resolvedPath, cwd)}`,
		};
	}
	if (code === "EACCES" || code === "EPERM") {
		return {
			ok: false,
			code: "permission_denied",
			message: `Access denied: ${formatPathRelativeToCwdOrAbsolute(resolvedPath, cwd)}`,
		};
	}
	if (code === "EISDIR") {
		return {
			ok: false,
			code: "not_file",
			message: `Is a directory: ${formatPathRelativeToCwdOrAbsolute(resolvedPath, cwd)}`,
		};
	}
	return { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) };
}

async function readTextLines(resolvedPath: string, params: FilePreviewParams): Promise<ReadFileLinesOutcome> {
	const { cwd } = params;
	const startLine = params.startLine;
	const endLine = params.endLine;
	if (startLine !== undefined && startLine < 1) {
		return {
			ok: false,
			code: "invalid_range",
			message: `Invalid line range: start line must be >= 1 (got ${startLine}).`,
		};
	}
	if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
		return {
			ok: false,
			code: "invalid_range",
			message: `Invalid line range: end line ${endLine} is before start line ${startLine}.`,
		};
	}

	// Streaming scan: count all lines, keep only the requested window.
	const lines: FilePreviewLine[] = [];
	let totalLines = 0;
	let pending = "";
	const decoder = new StringDecoder("utf8");
	const stream = createReadStream(resolvedPath, { highWaterMark: 64 * 1024 });
	let streamError: unknown;

	try {
		for await (const chunk of stream) {
			pending += decoder.write(chunk as Buffer);
			let newlineIndex = pending.indexOf("\n");
			while (newlineIndex !== -1) {
				totalLines += 1;
				const rawLine = pending.slice(0, newlineIndex);
				pending = pending.slice(newlineIndex + 1);
				collectWindowLine(rawLine, totalLines, lines, startLine, endLine);
				newlineIndex = pending.indexOf("\n");
			}
		}
		pending += decoder.end();
		if (pending.length > 0) {
			totalLines += 1;
			collectWindowLine(pending, totalLines, lines, startLine, endLine);
		}
	} catch (error: unknown) {
		streamError = error;
	}

	if (streamError) {
		return mapFileError(streamError, resolvedPath, cwd);
	}

	if (startLine !== undefined && startLine > totalLines) {
		return {
			ok: false,
			code: "invalid_range",
			message: `Invalid line range: start line ${startLine} is beyond the file's ${totalLines} lines.`,
		};
	}
	// Clamp the end of the range to the real file.
	const effectiveStart = startLine ?? 1;

	// Apply the shared Read-tool limits to the requested window.
	const joined = lines.map((line) => line.text).join("\n");
	const truncated = truncateHead(joined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	const contentText = truncated.content;
	const shownLines = contentText.length === 0 ? [] : contentText.split("\n");
	const finalLines = shownLines.map((text, index) => ({
		lineNumber: effectiveStart + index,
		text,
	}));
	const totalBytes = await fileByteLength(resolvedPath);

	const truncation: FilePreviewTruncation = {
		truncatedBy: truncated.truncatedBy,
		totalLines,
		totalBytes,
		shownLines: finalLines.length,
		shownBytes: Buffer.byteLength(contentText, "utf-8"),
		maxLines: truncated.maxLines,
		maxBytes: truncated.maxBytes,
		firstLineExceedsLimit: truncated.firstLineExceedsLimit,
	};

	return {
		ok: true,
		resolvedPath,
		lines: finalLines,
		totalLines,
		totalBytes,
		contentText,
		contentHash: hashText(contentText),
		truncated: truncated.truncated,
		truncation,
	};
}

function collectWindowLine(
	rawLine: string,
	lineNumber: number,
	lines: FilePreviewLine[],
	startLine: number | undefined,
	endLine: number | undefined,
): void {
	if (startLine !== undefined && lineNumber < startLine) return;
	if (endLine !== undefined && lineNumber > endLine) return;
	// Strip exactly one trailing CR so CRLF files render cleanly while line
	// mapping stays 1:1 (splitting is done on `\n` only).
	const text = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
	lines.push({ lineNumber, text });
}

async function fileByteLength(resolvedPath: string): Promise<number> {
	try {
		const fileStat = await stat(resolvedPath);
		return fileStat.size;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Public preview API
// ---------------------------------------------------------------------------

export function hashText(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export async function getFilePreview(params: FilePreviewParams): Promise<FilePreviewResult> {
	const outcome = await previewFile(params);
	if (!outcome.ok) {
		if (outcome.code === "binary") {
			const resolvedPath = resolveToCwd(params.path, params.cwd);
			const fileStat = await stat(resolvedPath).catch(() => undefined);
			return {
				ok: true,
				preview: {
					path: params.path,
					resolvedPath,
					displayPath: formatPathRelativeToCwdOrAbsolute(resolvedPath, params.cwd),
					cwd: params.cwd,
					kind: "binary",
					encoding: "utf-8",
					size: fileStat?.size ?? 0,
					typeHint: typeHintForPath(resolvedPath),
					lineCount: 0,
					lines: [],
					contentText: "",
					contentHash: hashText(""),
					truncated: false,
					binaryNote: "Binary file · Preview not available",
					snapshotAt: Date.now(),
				},
			};
		}
		return { ok: false, code: outcome.code, message: outcome.message };
	}

	const resolvedPath = outcome.resolvedPath;
	const fileStat = await stat(resolvedPath).catch(() => undefined);
	const empty = outcome.totalLines === 0 && outcome.totalBytes === 0;
	return {
		ok: true,
		preview: {
			path: params.path,
			resolvedPath,
			displayPath: formatPathRelativeToCwdOrAbsolute(resolvedPath, params.cwd),
			cwd: params.cwd,
			kind: empty ? "empty" : "text",
			language: languageForPath(resolvedPath),
			encoding: "utf-8",
			size: fileStat?.size ?? 0,
			lineCount: outcome.totalLines,
			lines: outcome.lines,
			shownStartLine: outcome.lines.length > 0 ? outcome.lines[0].lineNumber : undefined,
			shownEndLine: outcome.lines.length > 0 ? outcome.lines[outcome.lines.length - 1].lineNumber : undefined,
			contentText: outcome.contentText,
			contentHash: outcome.contentHash,
			truncated: outcome.truncated,
			truncation: outcome.truncation,
			snapshotAt: Date.now(),
		},
	};
}
