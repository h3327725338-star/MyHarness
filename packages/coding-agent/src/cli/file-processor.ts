/**
 * Process @file CLI arguments into text content and image attachments
 */

import { createReadStream, type Dirent } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import type { ImageContent } from "@myharness/ai";
import chalk from "chalk";
import { join, resolve } from "path";
import {
	createDocumentCollectionManifest,
	type DocumentManifestReference,
	formatDocumentCollectionNotice,
	readDocumentCorpusManifest,
} from "../agent/vision/document-corpus.ts";
import { getAgentDir } from "../config.ts";
import { resolveReadPath } from "../tools/path-utils.ts";
import { isSupportedRichFileExtension, preprocessLocalFile } from "../utils/file-preprocess.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Whether rich files should produce visual attachments. Default: true */
	includeImages?: boolean;
	/** Override the persistent document corpus directory. */
	documentCorpusDirectory?: string;
	/** Omit document preview images because Vision Assistant will consume the manifest. */
	omitDocumentPreviewImages?: boolean;
}

/** Keep one @file argument from consuming the entire agent context or heap. */
export const MAX_CLI_TEXT_BYTES = 10 * 1024 * 1024;
/** Keep a batch of @file arguments bounded as well. */
export const MAX_CLI_TOTAL_TEXT_BYTES = 20 * 1024 * 1024;

async function readTextWithBudget(
	filePath: string,
	maxBytes = MAX_CLI_TEXT_BYTES,
): Promise<{
	text: string;
	truncated: boolean;
	bytesRead: number;
}> {
	const decoder = new TextDecoder();
	let text = "";
	let bytesRead = 0;
	let truncated = false;
	const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
	try {
		for await (const chunk of stream) {
			const buffer = chunk as Buffer;
			if (bytesRead >= maxBytes) {
				truncated = true;
				break;
			}
			const remaining = maxBytes - bytesRead;
			const part = buffer.subarray(0, remaining);
			bytesRead += part.length;
			text += decoder.decode(part, { stream: true });
			if (part.length < buffer.length) {
				truncated = true;
				break;
			}
		}
		text += decoder.decode();
	} finally {
		stream.destroy();
	}
	return { text, truncated, bytesRead };
}

async function collectDirectoryDocuments(directory: string, failures: string[]): Promise<string[]> {
	const files: string[] = [];
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		failures.push(`无法读取目录 ${directory}：${error instanceof Error ? error.message : String(error)}`);
		return files;
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await collectDirectoryDocuments(path, failures)));
		else if (entry.isFile() && isSupportedRichFileExtension(entry.name.slice(entry.name.lastIndexOf(".")))) {
			files.push(path);
		}
	}
	return files;
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const includeImages = options?.includeImages ?? true;
	const documentCorpusDirectory = options?.documentCorpusDirectory;
	const omitDocumentPreviewImages = options?.omitDocumentPreviewImages ?? false;
	let text = "";
	const images: ImageContent[] = [];
	const expandedFiles: string[] = [];
	const deferredDocumentPrompts: Array<{
		sourcePath: string;
		notice: string;
		reference: DocumentManifestReference;
	}> = [];
	const failures: string[] = [];
	let cliTextBytes = 0;

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			const message = `文件不存在：${absolutePath}`;
			console.error(chalk.red(`Error: ${message}`));
			failures.push(message);
			continue;
		}
		try {
			const inputStats = await stat(absolutePath);
			if (inputStats.isDirectory()) {
				const discovered = await collectDirectoryDocuments(absolutePath, failures);
				if (discovered.length === 0) failures.push(`目录中没有可处理的文档或图片：${absolutePath}`);
				expandedFiles.push(...discovered);
			} else {
				expandedFiles.push(absolutePath);
			}
		} catch (error) {
			const message = `无法扫描 ${absolutePath}：${error instanceof Error ? error.message : String(error)}`;
			console.error(chalk.red(`Error: ${message}`));
			failures.push(message);
		}
	}

	for (const absolutePath of expandedFiles) {
		try {
			// The file may disappear after directory scanning. Treat that as one failed
			// item instead of aborting the whole collection.
			const stats = await stat(absolutePath);
			if (stats.size === 0) {
				failures.push(`文件为空：${absolutePath}`);
				continue;
			}
			const preprocessed = await preprocessLocalFile(absolutePath, {
				autoResizeImages,
				includeImages,
				documentCorpusDirectory,
			});
			if (preprocessed) {
				// Large document collections are analyzed from persistent manifests so
				// thousands of page previews never accumulate in the initial request.
				if (!preprocessed.documentManifestPath || (!omitDocumentPreviewImages && expandedFiles.length <= 4)) {
					images.push(...preprocessed.images);
				}
				const promptText =
					expandedFiles.length > 4 && preprocessed.documentCorpusNotice
						? preprocessed.documentCorpusNotice
						: preprocessed.text;
				if (expandedFiles.length > 4 && preprocessed.documentManifestPath && preprocessed.documentCorpusNotice) {
					const manifest = await readDocumentCorpusManifest(preprocessed.documentManifestPath);
					if (manifest) {
						deferredDocumentPrompts.push({
							sourcePath: absolutePath,
							notice: promptText,
							reference: {
								path: preprocessed.documentManifestPath,
								accessToken: manifest.accessToken,
							},
						});
						continue;
					}
				}
				text += `<file name="${absolutePath}">\n${promptText}\n</file>\n`;
				continue;
			}

			// Handle text file
			const remainingBatchBudget = Math.max(0, MAX_CLI_TOTAL_TEXT_BYTES - cliTextBytes);
			const fileBudget = Math.min(MAX_CLI_TEXT_BYTES, remainingBatchBudget);
			const content = await readTextWithBudget(absolutePath, fileBudget);
			cliTextBytes += content.bytesRead;
			const truncationNotice = content.truncated
				? `\n\n[文件文本注入已达到预算，仅注入前 ${fileBudget} 字节；其余内容未注入。请使用 read 工具的 offset/limit 或 shell 分段读取。]`
				: "";
			text += `<file name="${absolutePath}">\n${content.text}${truncationNotice}\n</file>\n`;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: Could not process file ${absolutePath}: ${message}`));
			failures.push(`无法处理 ${absolutePath}：${message}`);
		}
	}

	if (deferredDocumentPrompts.length > 20) {
		const collectionDirectory = join(
			documentCorpusDirectory ?? join(getAgentDir(), "document-corpus"),
			"collections",
		);
		const collection = await createDocumentCollectionManifest(
			deferredDocumentPrompts.map((entry) => entry.reference),
			collectionDirectory,
		);
		text += `${formatDocumentCollectionNotice(collection.manifest, collection.path)}\n`;
	} else {
		for (const entry of deferredDocumentPrompts) {
			text += `<file name="${entry.sourcePath}">\n${entry.notice}\n</file>\n`;
		}
	}

	if (failures.length > 0) {
		text += [
			`[文件批处理：${expandedFiles.length} 个候选文件，${failures.length} 个失败]`,
			...failures.map((failure) => `- ${failure}`),
			"其余文件已继续处理；失败文件没有被静默忽略。",
			"",
		].join("\n");
	}

	return { text, images };
}
