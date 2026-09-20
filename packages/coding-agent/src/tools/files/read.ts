import { constants, createReadStream } from "node:fs";
import type { AgentTool } from "@myharness/agent-core";
import type { ImageContent, TextContent } from "@myharness/ai";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { type Static, Type } from "typebox";
import { loadSystemPrompt, loadSystemPromptLines } from "../../system-prompts/loader/index.ts";
import { type PreprocessedLocalFile, preprocessLocalFile } from "../../utils/file-preprocess.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { OutputAccumulator } from "../output-accumulator.ts";
import { resolveReadPathAsync } from "../path-utils.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import { discardTemporaryToolOutput, FULL_TEXT_OUTPUT } from "../tool-result-persistence.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "../truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "File path to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-based)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

// Small files keep the exact historical continuation counts. For larger files,
// a finite line request stops the stream once the requested range is complete;
// counting every remaining line would defeat the bounded-read contract.
const EXACT_TOTAL_LINE_SCAN_BYTES = 1 * 1024 * 1024;

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export interface ReadTextRangeResult {
	outputText: string;
	details?: ReadToolDetails;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Stream a bounded text range without loading the whole file into memory. */
	readTextRange?: (
		absolutePath: string,
		displayPath: string,
		offset: number | undefined,
		limit: number | undefined,
		signal?: AbortSignal,
	) => Promise<ReadTextRangeResult>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/** Preprocess local documents, videos, and uncommon image formats. */
	preprocessFile?: (
		absolutePath: string,
		autoResizeImages: boolean,
		signal?: AbortSignal,
		includeImages?: boolean,
	) => Promise<PreprocessedLocalFile | null>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	readTextRange: readTextRangeFromFile,
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	preprocessFile: (path, autoResizeImages, signal, includeImages) =>
		preprocessLocalFile(path, { autoResizeImages, signal, includeImages }),
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Whether rich files should produce visual attachments. Default: true */
	includeImages?: boolean;
	/** Omit document previews because Vision Assistant will consume the persistent manifest. */
	omitDocumentPreviewImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

function validateReadRange(offset: number | undefined, limit: number | undefined): void {
	if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 1)) {
		throw new Error("offset must be a positive integer (1-based)");
	}
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
		throw new Error("limit must be a positive integer");
	}
}

function prepareTextRead(
	textContent: string,
	path: string,
	offset: number | undefined,
	limit: number | undefined,
): { outputText: string; details?: ReadToolDetails; fullTextOutput?: string } {
	validateReadRange(offset, limit);
	const allLines = textContent.split("\n");
	const totalFileLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
	}
	let selectedContent: string;
	let userLimitedLines: number | undefined;
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, allLines.length);
		selectedContent = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	} else {
		selectedContent = allLines.slice(startLine).join("\n");
	}
	const truncation = truncateHead(selectedContent);
	const fullTextOutput = truncation.truncated ? selectedContent : undefined;
	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
		return {
			outputText: `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`,
			details: { truncation },
			fullTextOutput,
		};
	}
	if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		const notice =
			truncation.truncatedBy === "lines"
				? `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
				: `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		return {
			outputText: `${truncation.content}\n\n${notice}`,
			details: { truncation },
			fullTextOutput,
		};
	}
	if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		return {
			outputText: `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`,
			fullTextOutput,
		};
	}
	return { outputText: truncation.content, fullTextOutput };
}

async function readTextRangeFromFile(
	absolutePath: string,
	displayPath: string,
	offset: number | undefined,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<ReadTextRangeResult> {
	validateReadRange(offset, limit);
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const endLine = limit === undefined ? Number.POSITIVE_INFINITY : startLine + Math.max(0, limit);
	const fileSize = (await fsStat(absolutePath)).size;
	if (fileSize === 0) {
		if (startLine > 0) {
			throw new Error(`Offset ${offset} is beyond end of file (0 lines total)`);
		}
		return { outputText: "" };
	}
	const scanPastRequestedRange = limit === undefined || fileSize <= EXACT_TOTAL_LINE_SCAN_BYTES;
	const output = new OutputAccumulator({ tempFilePrefix: "myharness-read", mode: "head" });
	const stream = createReadStream(absolutePath, { highWaterMark: 64 * 1024 });
	const decoder = new TextDecoder();
	let lineNumber = 0;
	let totalNewlines = 0;
	let pendingCarriageReturn = false;
	let firstSelectedLineBytes = 0;
	let stoppedEarly = false;
	let lastByte: number | undefined;

	const appendSelected = (text: string): void => {
		if (lineNumber < startLine || lineNumber >= endLine) return;
		if (!text) return;
		const bytes = Buffer.byteLength(text, "utf8");
		output.append(Buffer.from(text, "utf8"));
		if (lineNumber === startLine) firstSelectedLineBytes += bytes;
	};
	const appendNewline = (): void => {
		if (lineNumber >= startLine && lineNumber + 1 < endLine) output.append(Buffer.from("\n"));
		lineNumber++;
		if (limit !== undefined && Number.isFinite(limit) && limit > 0 && lineNumber >= endLine) {
			stoppedEarly = true;
		}
	};
	const processText = (text: string): void => {
		if (pendingCarriageReturn) {
			if (text.startsWith("\n")) text = text.slice(1);
			else appendSelected("\r");
			pendingCarriageReturn = false;
		}
		const parts = text.split("\n");
		for (let index = 0; index < parts.length - 1; index++) {
			let line = parts[index] ?? "";
			if (line.endsWith("\r")) line = line.slice(0, -1);
			appendSelected(line);
			appendNewline();
			if (stoppedEarly) return;
		}
		let tail = parts[parts.length - 1] ?? "";
		if (tail.endsWith("\r")) {
			tail = tail.slice(0, -1);
			pendingCarriageReturn = true;
		}
		appendSelected(tail);
	};

	try {
		for await (const chunk of stream) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const buffer = chunk as Buffer;
			if (buffer.length > 0) lastByte = buffer[buffer.length - 1];
			for (const byte of buffer) {
				if (byte === 0x0a) totalNewlines++;
			}
			// Once the requested range is complete, keep only the cheap newline
			// count needed for the continuation notice. Do not decode or append the
			// remainder of a large file.
			if (!stoppedEarly) processText(decoder.decode(buffer, { stream: true }));
			if (stoppedEarly && !scanPastRequestedRange) break;
		}
		if (!stoppedEarly) {
			processText(decoder.decode());
			if (pendingCarriageReturn) {
				appendSelected("\r");
				pendingCarriageReturn = false;
			}
		}
	} catch (error) {
		await output.discardTempFile();
		throw error;
	} finally {
		stream.destroy();
	}

	const totalFileLines = fileSize === 0 ? 0 : totalNewlines + (lastByte === 0x0a ? 0 : 1);
	if (startLine >= totalFileLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
	}
	output.finish();
	const snapshot = output.snapshot({ persistIfTruncated: true });
	await output.closeTempFile();
	const truncation = snapshot.truncation;
	const outputDetails: ReadToolDetails | undefined = snapshot.fullOutputPath
		? { fullOutputPath: snapshot.fullOutputPath }
		: undefined;
	if (truncation.firstLineExceedsLimit) {
		return {
			outputText: `[Line ${startLine + 1} is ${formatSize(firstSelectedLineBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLine + 1}p' ${displayPath} | head -c ${DEFAULT_MAX_BYTES}]`,
			details: { truncation, ...(outputDetails ?? {}) },
		};
	}
	if (truncation.truncated) {
		const endLineDisplay = startLine + truncation.outputLines;
		const nextOffset = endLineDisplay + 1;
		const notice = !scanPastRequestedRange
			? `[Showing lines ${startLine + 1}-${endLineDisplay}. More lines may exist; use offset=${nextOffset} to continue.]`
			: truncation.truncatedBy === "lines"
				? `[Showing lines ${startLine + 1}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
				: `[Showing lines ${startLine + 1}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		return {
			outputText: `${truncation.content}\n\n${notice}`,
			details: { truncation, ...(outputDetails ?? {}) },
		};
	}
	if (limit !== undefined && !scanPastRequestedRange && stoppedEarly) {
		return {
			outputText: `${snapshot.content}\n\n[More lines may exist in file. Use offset=${startLine + limit + 1} to continue.]`,
			details: outputDetails,
		};
	}
	if (limit !== undefined && startLine + limit < totalFileLines) {
		const remaining = totalFileLines - (startLine + limit);
		return {
			outputText: `${snapshot.content}\n\n[${remaining} more lines in file. Use offset=${startLine + limit + 1} to continue.]`,
			details: outputDetails,
		};
	}
	return { outputText: snapshot.content, details: outputDetails };
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): BusinessToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const includeImages = options?.includeImages ?? true;
	const omitDocumentPreviewImages = options?.omitDocumentPreviewImages ?? false;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Reads files. Supports text, common images and converted images, PDFs, modern Office documents, SVG, PSD, and video keyframes. Binary files are preprocessed before being sent. Text output is capped at ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB, whichever is reached first. Use offset and limit when reading large text.`,
		promptSnippet: loadSystemPrompt("tools/read/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/read/guidelines.md"),
		parameters: readSchema,
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					try {
						validateReadRange(offset, limit);
					} catch (error) {
						reject(error);
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						let temporaryFullOutputPath: string | undefined;
						try {
							const absolutePath = await resolveReadPathAsync(path, cwd);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const preprocessed = ops.preprocessFile
								? await ops.preprocessFile(absolutePath, autoResizeImages, signal, includeImages)
								: undefined;
							const mimeType =
								!preprocessed && ops.detectImageMimeType
									? await ops.detectImageMimeType(absolutePath)
									: undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							let fullTextOutput: string | undefined;
							if (preprocessed) {
								const prepared = prepareTextRead(
									preprocessed.fullText ?? preprocessed.text,
									path,
									offset,
									limit,
								);
								const shouldAttachImages =
									includeImages &&
									(offset === undefined || offset <= 1) &&
									(!omitDocumentPreviewImages || !preprocessed.documentManifestPath);
								content = [
									{ type: "text", text: prepared.outputText },
									...(shouldAttachImages ? preprocessed.images : []),
								];
								details = prepared.details;
								fullTextOutput = prepared.fullTextOutput;
							} else if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, { autoResizeImages });
								if (!processed.ok) {
									const textNote = `Read image file [${mimeType}]\n${processed.message}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Read text content.
								const prepared = ops.readTextRange
									? await ops.readTextRange(absolutePath, path, offset, limit, signal)
									: prepareTextRead((await ops.readFile(absolutePath)).toString("utf-8"), path, offset, limit);
								content = [{ type: "text", text: prepared.outputText }];
								details = prepared.details;
								temporaryFullOutputPath = details?.fullOutputPath;
								fullTextOutput =
									"fullTextOutput" in prepared && typeof prepared.fullTextOutput === "string"
										? prepared.fullTextOutput
										: undefined;
							}

							if (aborted) {
								await discardTemporaryToolOutput(temporaryFullOutputPath);
								return;
							}
							signal?.removeEventListener("abort", onAbort);
							const result = { content, details };
							if (fullTextOutput !== undefined) {
								Object.assign(result, { [FULL_TEXT_OUTPUT]: fullTextOutput });
							}
							resolve(result);
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							await discardTemporaryToolOutput(temporaryFullOutputPath);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
