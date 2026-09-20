import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { ImageContent } from "@myharness/ai";
import type { OfficeChunk } from "officeparser";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderParameters } from "pdfjs-dist/types/src/display/api.js";
import {
	createDocumentCorpusManifest,
	type DocumentCorpusManifest,
	type DocumentCorpusUnit,
	formatDocumentCorpusNotice,
	getDocumentCorpusPaths,
	isSameDocumentSource,
	prepareDocumentCorpusDirectories,
	readDocumentCorpusManifest,
	writeDocumentCorpusManifest,
} from "../agent/vision/document-corpus.ts";
import { isBunBinary } from "../config.ts";
import { processImage } from "./image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "./mime.ts";
import { killProcessTreeAndWait } from "./shell.ts";

const require = createRequire(import.meta.url);

const MAX_DOCUMENT_IMAGES = 8;
const MAX_INLINE_PDF_PAGES = 12;
const MAX_VIDEO_FRAMES = 8;
const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const MAX_IMAGE_PIXELS = 100_000_000;
const MAX_PSD_DECODE_BYTES = 512 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 60_000;
const MAX_PROCESS_STDERR_BYTES = 64 * 1024;
const MAX_OFFICE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_OFFICE_ZIP_ENTRIES = 5_000;
const PREPROCESS_CACHE_ENTRIES = 16;
const PREPROCESS_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const PREPROCESS_CACHE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_INPUT_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_DOCUMENT_INPUT_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_PDF_INPUT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_PSD_INPUT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_INPUT_BYTES = 20 * 1024 * 1024 * 1024;

const RASTER_IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".heic", ".heif", ".jxl", ".tif", ".tiff"]);
const INLINE_IMAGE_EXTENSIONS = new Set([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const SVG_EXTENSIONS = new Set([".svg", ".svgz"]);
const PSD_EXTENSIONS = new Set([".psd", ".psb"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".rtf"]);
const LEGACY_OFFICE_EXTENSIONS = new Set([".doc", ".xls", ".ppt"]);
const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".wma"]);

/** Formats that can be discovered safely when a directory is passed through @. */
export function isSupportedRichFileExtension(extension: string): boolean {
	const normalized = extension.toLowerCase();
	return (
		INLINE_IMAGE_EXTENSIONS.has(normalized) ||
		RASTER_IMAGE_EXTENSIONS.has(normalized) ||
		SVG_EXTENSIONS.has(normalized) ||
		PSD_EXTENSIONS.has(normalized) ||
		PDF_EXTENSIONS.has(normalized) ||
		OFFICE_EXTENSIONS.has(normalized) ||
		LEGACY_OFFICE_EXTENSIONS.has(normalized) ||
		VIDEO_EXTENSIONS.has(normalized)
	);
}

export type PreprocessedFileKind = "image" | "document" | "pdf" | "video" | "unsupported";

export interface PreprocessedLocalFile {
	kind: PreprocessedFileKind;
	/** Prompt-safe preview used by @file and compact displays. */
	text: string;
	/** Complete extracted text for paged Read access and persisted tool output. */
	fullText?: string;
	images: ImageContent[];
	/** Persistent page-level corpus used for exhaustive visual analysis and exact source retrieval. */
	documentManifestPath?: string;
	/** Compact prompt notice used instead of embedding every document preview in large collections. */
	documentCorpusNotice?: string;
}

export interface PreprocessLocalFileOptions {
	autoResizeImages?: boolean;
	/** Cancel parsing, conversion workers, and child processes. */
	signal?: AbortSignal;
	/** Skip visual rendering while still extracting document text. */
	includeImages?: boolean;
	/** Override the format-specific single-file input limit. */
	maxInputBytes?: number;
	/** Directory for persistent page text, page images, and resumable manifests. */
	documentCorpusDirectory?: string;
}

interface PreprocessCacheEntry {
	key: string;
	result: PreprocessedLocalFile | null;
	size: number;
}

const preprocessCache = new Map<string, PreprocessCacheEntry>();
let preprocessCacheBytes = 0;

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
	}
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function clonePreprocessedResult(result: PreprocessedLocalFile | null): PreprocessedLocalFile | null {
	if (!result) return null;
	return {
		...result,
		fullText: result.fullText,
		images: result.images.map((image) => ({ ...image })),
	};
}

function estimatePreprocessedSize(result: PreprocessedLocalFile | null): number {
	if (!result) return 0;
	return (
		Buffer.byteLength(result.text, "utf8") +
		Buffer.byteLength(result.fullText ?? "", "utf8") +
		result.images.reduce((total, image) => total + image.data.length, 0)
	);
}

function getBinaryAssetDirectory(): string {
	return join(dirname(process.execPath), "rich-file-assets");
}

function getBinaryAssetRequire(): NodeJS.Require {
	return createRequire(join(getBinaryAssetDirectory(), "runtime.cjs"));
}

async function loadSharp(): Promise<typeof import("sharp")["default"]> {
	if (!isBunBinary) return (await import("sharp")).default;
	const entryPath = join(getBinaryAssetDirectory(), "node_modules", "sharp", "dist", "index.cjs");
	return getBinaryAssetRequire()(entryPath) as typeof import("sharp")["default"];
}

async function loadCanvas(): Promise<typeof import("@napi-rs/canvas")> {
	if (!isBunBinary) return import("@napi-rs/canvas");
	const entryPath = join(getBinaryAssetDirectory(), "node_modules", "@napi-rs", "canvas", "index.js");
	return getBinaryAssetRequire()(entryPath) as typeof import("@napi-rs/canvas");
}

function getFfmpegPath(): string | null {
	if (!isBunBinary) return require("ffmpeg-static") as string | null;
	const executable = join(getBinaryAssetDirectory(), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
	return existsSync(executable) ? executable : null;
}

function getPdfStandardFontDataUrl(): string {
	const directory = isBunBinary
		? join(getBinaryAssetDirectory(), "standard_fonts")
		: join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");
	return `${directory.replace(/\\/g, "/")}/`;
}

function getExtension(filePath: string): string {
	return extname(filePath).toLowerCase();
}

function limitText(text: string): string {
	if (text.length <= MAX_EXTRACTED_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n\n[文档文字过长，仅保留前 ${MAX_EXTRACTED_TEXT_CHARS} 个字符。]`;
}

function errorText(kind: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `[${kind}预处理失败：${message}]`;
}

function maximumInputBytes(extension: string): number | undefined {
	if (PDF_EXTENSIONS.has(extension)) return DEFAULT_MAX_PDF_INPUT_BYTES;
	if (OFFICE_EXTENSIONS.has(extension)) return DEFAULT_MAX_DOCUMENT_INPUT_BYTES;
	if (PSD_EXTENSIONS.has(extension)) return DEFAULT_MAX_PSD_INPUT_BYTES;
	if (VIDEO_EXTENSIONS.has(extension)) return DEFAULT_MAX_VIDEO_INPUT_BYTES;
	if (
		INLINE_IMAGE_EXTENSIONS.has(extension) ||
		RASTER_IMAGE_EXTENSIONS.has(extension) ||
		SVG_EXTENSIONS.has(extension)
	) {
		return DEFAULT_MAX_IMAGE_INPUT_BYTES;
	}
	return undefined;
}

function formatInputLimit(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024 * 1024))} GB`;
	if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

async function toImageContent(
	bytes: Uint8Array,
	mimeType: string,
	autoResizeImages: boolean,
	signal?: AbortSignal,
): Promise<{ image?: ImageContent; hints: string[]; error?: string }> {
	const processed = await processImage(bytes, mimeType, { autoResizeImages, signal });
	if (!processed.ok) return { hints: [], error: processed.message };
	return {
		image: { type: "image", mimeType: processed.mimeType, data: processed.data },
		hints: processed.hints,
	};
}

async function convertWithSharp(filePath: string, extension: string): Promise<Buffer> {
	const sharp = await loadSharp();
	try {
		return await sharp(filePath, { animated: false, failOn: "error", limitInputPixels: 100_000_000 })
			.rotate()
			.png()
			.toBuffer();
	} catch (error) {
		if (extension !== ".heic" && extension !== ".heif") throw error;
		const { default: decodeHeic } = await import("heic-decode");
		const decoded = await decodeHeic({ buffer: await readFile(filePath) });
		if (decoded.width * decoded.height > 100_000_000) throw new Error("HEIC 图像像素数量超过安全上限");
		return sharp(Buffer.from(decoded.data), {
			raw: { width: decoded.width, height: decoded.height, channels: 4 },
		})
			.png()
			.toBuffer();
	}
}

async function convertPsd(filePath: string): Promise<Buffer> {
	const [{ createCanvas }, { getCompositeImageData, initializeCanvas, readPsd }, { PNG }] = await Promise.all([
		loadCanvas(),
		import("ag-psd"),
		import("pngjs"),
	]);
	const createPsdCanvas = ((width: number, height: number) => createCanvas(width, height)) as unknown as Parameters<
		typeof initializeCanvas
	>[0];
	initializeCanvas(createPsdCanvas);
	const source = await readFile(filePath);
	const metadata = readPsd(source, {
		useRawData: true,
		skipLayerImageData: true,
		skipThumbnail: true,
		skipCompositeImageData: true,
		skipLinkedFilesData: true,
		totalMemoryLimit: MAX_PSD_DECODE_BYTES,
	});
	if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
		throw new Error("PSD 图像像素数量超过安全上限");
	}
	const psd = readPsd(source, {
		useRawData: true,
		useRawThumbnail: true,
		skipLayerImageData: true,
		skipThumbnail: true,
		skipLinkedFilesData: true,
		totalMemoryLimit: MAX_PSD_DECODE_BYTES,
	});
	const composite = getCompositeImageData(psd);
	if (!composite) throw new Error("PSD 中没有可渲染的合成图像");
	const png = new PNG({ width: composite.width, height: composite.height });
	png.data = Buffer.from(composite.data);
	return PNG.sync.write(png);
}

async function runProcess(
	command: string,
	args: string[],
	timeoutMs = CONVERSION_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		throwIfAborted(signal);
		const child = spawn(command, args, {
			windowsHide: true,
			shell: false,
			detached: process.platform !== "win32",
		});
		let stderr = "";
		let settled = false;
		let terminationPromise: Promise<boolean> | undefined;
		const finish = (error?: Error, output?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(output ?? "");
		};
		const terminate = (error: Error) => {
			if (settled) return;
			if (child.pid) {
				terminationPromise ??= killProcessTreeAndWait(child.pid).catch(() => false);
				void terminationPromise.then(
					() => finish(error),
					() => finish(error),
				);
			} else {
				finish(error);
			}
		};
		const onAbort = () => terminate(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => {
			terminate(new Error(`转换超过 ${Math.round(timeoutMs / 1000)} 秒`));
		}, timeoutMs);
		child.stderr?.on("data", (chunk: Buffer | string) => {
			if (stderr.length < MAX_PROCESS_STDERR_BYTES) {
				stderr += chunk.toString().slice(0, MAX_PROCESS_STDERR_BYTES - stderr.length);
			}
		});
		child.on("error", (error) => {
			if (terminationPromise) return;
			finish(error);
		});
		child.on("close", (code) => {
			if (terminationPromise) return;
			if (code === 0) {
				finish(undefined, stderr);
				return;
			}
			const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" ");
			finish(new Error(detail || `转换进程退出码 ${code ?? "未知"}`));
		});
	});
}

async function convertJxl(filePath: string, signal?: AbortSignal): Promise<Buffer> {
	throwIfAborted(signal);
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "myharness-jxl-"));
	const outputPath = join(temporaryDirectory, "decoded.png");
	try {
		const decoderPath = isBunBinary
			? join(getBinaryAssetDirectory(), "node_modules", "jxl-wasm", "lib", "djxl-wrap.js")
			: require.resolve("jxl-wasm/lib/djxl-wrap.js");
		const workerSpecifier: string | URL =
			typeof process.versions.bun === "string"
				? "./src/utils/jxl-decode-worker.ts"
				: new URL(
						import.meta.url.endsWith(".ts") ? "./jxl-decode-worker.ts" : "./jxl-decode-worker.js",
						import.meta.url,
					);
		await new Promise<void>((resolve, reject) => {
			const worker = new Worker(workerSpecifier, { execArgv: [], stdout: true, stderr: true });
			worker.stdout?.resume();
			worker.stderr?.resume();
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				void worker.terminate();
				reject(new Error("JPEG XL 转换超过 60 秒"));
			}, CONVERSION_TIMEOUT_MS);
			const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				void worker.terminate();
				if (error) reject(error);
				else resolve();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			worker.once("message", (response: { error?: string }) => {
				finish(response.error ? new Error(response.error) : undefined);
			});
			worker.once("error", finish);
			worker.once("exit", (code) => {
				if (!settled) finish(new Error(`JPEG XL 转换进程退出码 ${code}`));
			});
			worker.postMessage({ wrapperPath: decoderPath, inputPath: filePath, outputPath });
		});
		return await readFile(outputPath);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

async function preprocessImage(
	filePath: string,
	extension: string,
	autoResizeImages: boolean,
	signal?: AbortSignal,
): Promise<PreprocessedLocalFile> {
	try {
		throwIfAborted(signal);
		const directlySupportedMimeType = await detectSupportedImageMimeTypeFromFile(filePath);
		if (directlySupportedMimeType) {
			const converted = await toImageContent(
				await readFile(filePath, { signal }),
				directlySupportedMimeType,
				autoResizeImages,
				signal,
			);
			const displayedMimeType = converted.image?.mimeType ?? directlySupportedMimeType;
			const lines = [`读取图片文件 [${displayedMimeType}]`, ...converted.hints];
			if (converted.error) lines.push(converted.error);
			return { kind: "image", text: lines.join("\n"), images: converted.image ? [converted.image] : [] };
		}

		const pngBytes =
			extension === ".jxl"
				? await convertJxl(filePath, signal)
				: PSD_EXTENSIONS.has(extension)
					? await convertPsd(filePath)
					: await convertWithSharp(filePath, extension);
		throwIfAborted(signal);
		const converted = await toImageContent(pngBytes, "image/png", autoResizeImages, signal);
		const lines = [`已将 ${extension.slice(1).toUpperCase()} 转换为 PNG。`, ...converted.hints];
		if (converted.error) lines.push(converted.error);
		return { kind: "image", text: lines.join("\n"), images: converted.image ? [converted.image] : [] };
	} catch (error) {
		if (isAbortError(error, signal)) throw error;
		return { kind: "image", text: errorText("图像", error), images: [] };
	}
}

async function preprocessOfficeDocument(
	filePath: string,
	autoResizeImages: boolean,
	includeImages: boolean,
	signal?: AbortSignal,
	documentCorpusDirectory?: string,
): Promise<PreprocessedLocalFile> {
	try {
		throwIfAborted(signal);
		const { OfficeParser } = await import("officeparser");
		const ast = await OfficeParser.parseOffice(filePath, {
			extractAttachments: includeImages,
			ocr: false,
			includeRawContent: false,
			abortSignal: signal,
			decompressionLimits: {
				maxUncompressedBytes: MAX_OFFICE_UNCOMPRESSED_BYTES,
				maxZipEntries: MAX_OFFICE_ZIP_ENTRIES,
			},
		});
		const sourceStats = await stat(filePath);
		const corpusPaths = getDocumentCorpusPaths(
			filePath,
			sourceStats.size,
			sourceStats.mtimeMs,
			documentCorpusDirectory,
		);
		await prepareDocumentCorpusDirectories(corpusPaths);
		const images: ImageContent[] = [];
		const attachmentNotes: string[] = [];
		const previousManifest = await readDocumentCorpusManifest(corpusPaths.manifestPath);
		const imageAttachments = includeImages
			? ast.attachments.filter((attachment) => attachment.mimeType.startsWith("image/"))
			: [];
		const textResult = await ast.to("text", {
			includeImages: true,
			textConfig: { preserveLayout: true, renderNotes: true },
		});
		const extractedText = textResult.value.trim();
		const splitBy =
			ast.type === "pptx" || ast.type === "odp"
				? "slide"
				: ast.type === "xlsx" || ast.type === "ods"
					? "sheet"
					: ast.type === "docx" || ast.type === "odt"
						? "heading"
						: "paragraph";
		const chunksResult = await ast.to("chunks", {
			chunksConfig: {
				strategy: "document-structure",
				splitBy,
				maxChunkSize: 6_000,
				tableSplitStrategy: "row",
				addStartIndex: true,
			},
		});
		const chunks = Array.isArray(chunksResult.value)
			? chunksResult.value.filter((chunk) => chunk.text.trim().length > 0)
			: [];
		const fallbackChunks: OfficeChunk[] =
			chunks.length > 0
				? chunks
				: [
						{
							text: extractedText,
							metadata: { sourceType: ast.type },
						},
					];
		const manifest = createDocumentCorpusManifest(
			filePath,
			sourceStats.size,
			sourceStats.mtimeMs,
			"document",
			fallbackChunks.length + imageAttachments.length,
			corpusPaths,
		);
		if (
			previousManifest?.sourceSize === sourceStats.size &&
			previousManifest.sourceMtimeMs === sourceStats.mtimeMs &&
			isSameDocumentSource(previousManifest.sourcePath, manifest.sourcePath)
		) {
			manifest.accessToken = previousManifest.accessToken;
			manifest.visionStatus = previousManifest.visionStatus;
			manifest.visionCompletedUnits = previousManifest.visionCompletedUnits;
			manifest.visionFailedUnits = previousManifest.visionFailedUnits;
			manifest.visionError = previousManifest.visionError;
		}
		manifest.status = "processing";
		const units: DocumentCorpusUnit[] = [];
		const fullTextSections: string[] = [];
		for (let index = 0; index < fallbackChunks.length; index++) {
			const chunk = fallbackChunks[index]!;
			const metadata = chunk.metadata;
			const sourceAnchor =
				typeof metadata.pageNumber === "number"
					? `第 ${metadata.pageNumber} 页`
					: typeof metadata.slideNumber === "number"
						? `第 ${metadata.slideNumber} 张幻灯片`
						: typeof metadata.sheetName === "string" && metadata.sheetName
							? `工作表 ${metadata.sheetName}`
							: typeof metadata.closestHeading === "string" && metadata.closestHeading
								? `章节 ${metadata.closestHeading}`
								: `正文片段 ${index + 1}`;
			const label = `${manifest.sourceName} · ${sourceAnchor}`;
			const unitNumber = index + 1;
			const textPath = join(corpusPaths.textDirectory, `${String(unitNumber).padStart(6, "0")}.txt`);
			await writeFile(textPath, chunk.text, "utf8");
			fullTextSections.push(`[${label}]\n${chunk.text}`);
			units.push({
				unitNumber,
				label,
				status: "complete",
				sourceType: metadata.sourceType,
				pageNumber: typeof metadata.pageNumber === "number" ? metadata.pageNumber : undefined,
				slideNumber: typeof metadata.slideNumber === "number" ? metadata.slideNumber : undefined,
				sheetName: typeof metadata.sheetName === "string" ? metadata.sheetName : undefined,
				heading: typeof metadata.closestHeading === "string" ? metadata.closestHeading : undefined,
				textPath,
			});
		}
		const previousImageUnits = new Map(
			(previousManifest?.units ?? []).filter((unit) => unit.imagePath).map((unit) => [unit.label, unit]),
		);
		for (let index = 0; index < imageAttachments.length; index++) {
			const attachment = imageAttachments[index]!;
			throwIfAborted(signal);
			const unitNumber = fallbackChunks.length + index + 1;
			const imagePath = join(corpusPaths.imageDirectory, `${String(unitNumber).padStart(6, "0")}.png`);
			const label = `${manifest.sourceName} · 内嵌图片 ${index + 1}（${attachment.name}）`;
			try {
				const previousUnit = previousImageUnits.get(label);
				let image: ImageContent | undefined;
				if (previousUnit?.status === "complete" && previousUnit.imagePath && existsSync(previousUnit.imagePath)) {
					image = {
						type: "image",
						data: (await readFile(previousUnit.imagePath)).toString("base64"),
						mimeType: "image/png",
					};
				} else {
					const bytes = Buffer.from(attachment.data, "base64");
					const normalizedBytes = await (await loadSharp())(bytes, { animated: false }).png().toBuffer();
					const converted = await toImageContent(normalizedBytes, "image/png", autoResizeImages, signal);
					if (!converted.image) throw new Error(converted.error ?? "附件图像转换失败");
					image = converted.image;
					await writeFile(imagePath, Buffer.from(image.data, "base64"));
					if (converted.error) attachmentNotes.push(`${attachment.name}: ${converted.error}`);
				}
				if (images.length < MAX_DOCUMENT_IMAGES) images.push(image);
				units.push({
					unitNumber,
					label,
					status: "complete",
					sourceType: ast.type,
					imagePath: previousUnit?.imagePath ?? imagePath,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				attachmentNotes.push(`${attachment.name}: ${errorText("附件图像", error)}`);
				units.push({
					unitNumber,
					label,
					status: "failed",
					sourceType: ast.type,
					error: message,
				});
			}
			manifest.units = [...units];
			manifest.completedUnits = units.filter((unit) => unit.status === "complete").length;
			manifest.failedUnits = units.filter((unit) => unit.status === "failed").map((unit) => unit.unitNumber);
			manifest.updatedAt = Date.now();
			await writeDocumentCorpusManifest(corpusPaths.manifestPath, manifest);
		}
		if (!includeImages && previousManifest) {
			for (const previousUnit of previousManifest.units.filter(
				(unit) => unit.imagePath && unit.status === "complete" && existsSync(unit.imagePath),
			)) {
				if (units.some((unit) => unit.label === previousUnit.label)) continue;
				units.push({ ...previousUnit, unitNumber: units.length + 1 });
			}
		}
		const notes = [
			`已按${splitBy === "slide" ? "幻灯片" : splitBy === "sheet" ? "工作表" : splitBy === "heading" ? "章节" : "段落"}提取 ${ast.type.toUpperCase()} 文档完整文字${imageAttachments.length > 0 ? `和 ${imageAttachments.length} 张内嵌图片` : ""}。`,
		];
		if (imageAttachments.length > images.length) {
			notes.push(`当前消息只附带 ${images.length} 张预览；其余图片保存在持久化资料库中。`);
		}
		if (attachmentNotes.length > 0) notes.push(...attachmentNotes);
		const corpusFullText = fullTextSections.join("\n\n");
		await writeFile(corpusPaths.fullTextPath, `${corpusFullText}\n`, "utf8");
		manifest.units = units;
		manifest.totalUnits = units.length;
		manifest.completedUnits = units.filter((unit) => unit.status === "complete").length;
		manifest.failedUnits = units.filter((unit) => unit.status === "failed").map((unit) => unit.unitNumber);
		manifest.status = manifest.failedUnits.length > 0 ? "partial" : "complete";
		manifest.processingError = undefined;
		manifest.updatedAt = Date.now();
		await writeDocumentCorpusManifest(corpusPaths.manifestPath, manifest);
		const corpusNotice = formatDocumentCorpusNotice(manifest, corpusPaths.manifestPath);
		const fullText = `${notes.join("\n")}\n\n${corpusNotice}${corpusFullText ? `\n\n${limitText(corpusFullText)}` : ""}`;
		return {
			kind: "document",
			text: fullText,
			fullText,
			images,
			documentManifestPath: corpusPaths.manifestPath,
			documentCorpusNotice: corpusNotice,
		};
	} catch (error) {
		if (isAbortError(error, signal)) throw error;
		return { kind: "document", text: errorText("文档", error), images: [] };
	}
}

function selectEvenlyDistributedPages(totalPages: number, maximum: number): number[] {
	if (totalPages <= maximum) return Array.from({ length: totalPages }, (_, index) => index + 1);
	const pages = new Set<number>();
	for (let index = 0; index < maximum; index++) {
		pages.add(Math.round((index * (totalPages - 1)) / (maximum - 1)) + 1);
	}
	return [...pages].sort((left, right) => left - right);
}

async function preprocessPdf(
	filePath: string,
	autoResizeImages: boolean,
	includeImages: boolean,
	signal?: AbortSignal,
	documentCorpusDirectory?: string,
): Promise<PreprocessedLocalFile> {
	let document: PDFDocumentProxy | undefined;
	let loadingTask: PDFDocumentLoadingTask | undefined;
	const abortLoading = () => {
		void loadingTask?.destroy();
	};
	try {
		throwIfAborted(signal);
		const canvasModule = await loadCanvas();
		const runtimeGlobals = globalThis as Record<string, unknown>;
		runtimeGlobals.DOMMatrix ??= canvasModule.DOMMatrix;
		runtimeGlobals.ImageData ??= canvasModule.ImageData;
		runtimeGlobals.Path2D ??= canvasModule.Path2D;
		const pdfjs = isBunBinary
			? ((await import(
					pathToFileURL(join(getBinaryAssetDirectory(), "pdf.mjs")).href
				)) as typeof import("pdfjs-dist/legacy/build/pdf.mjs"))
			: await import("pdfjs-dist/legacy/build/pdf.mjs");
		if (isBunBinary) {
			pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(getBinaryAssetDirectory(), "pdf.worker.mjs")).href;
		}
		const { createCanvas } = canvasModule;
		const sourceStats = await stat(filePath);
		const corpusPaths = getDocumentCorpusPaths(
			filePath,
			sourceStats.size,
			sourceStats.mtimeMs,
			documentCorpusDirectory,
		);
		await prepareDocumentCorpusDirectories(corpusPaths);
		const createdLoadingTask = pdfjs.getDocument({
			data: new Uint8Array(await readFile(filePath)),
			standardFontDataUrl: getPdfStandardFontDataUrl(),
		});
		loadingTask = createdLoadingTask;
		signal?.addEventListener("abort", abortLoading, { once: true });
		document = await createdLoadingTask.promise;
		const inlinePages = includeImages
			? new Set(selectEvenlyDistributedPages(document.numPages, MAX_INLINE_PDF_PAGES))
			: new Set<number>();
		const previousManifest = await readDocumentCorpusManifest(corpusPaths.manifestPath);
		const manifest: DocumentCorpusManifest =
			previousManifest?.sourceSize === sourceStats.size &&
			previousManifest.sourceMtimeMs === sourceStats.mtimeMs &&
			previousManifest.totalUnits === document.numPages
				? { ...previousManifest, status: "processing", updatedAt: Date.now() }
				: createDocumentCorpusManifest(
						filePath,
						sourceStats.size,
						sourceStats.mtimeMs,
						"pdf",
						document.numPages,
						corpusPaths,
					);
		const previousUnits = new Map(manifest.units.map((unit) => [unit.unitNumber, unit]));
		const images: ImageContent[] = [];
		const failedPages: number[] = [];
		const pageTexts: string[] = [];
		const units: DocumentCorpusUnit[] = [];
		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
			throwIfAborted(signal);
			const pageLabel = `${manifest.sourceName} · 第 ${pageNumber} 页`;
			const textPath = join(corpusPaths.textDirectory, `${String(pageNumber).padStart(6, "0")}.txt`);
			const imagePath = join(corpusPaths.imageDirectory, `${String(pageNumber).padStart(6, "0")}.png`);
			const previousUnit = previousUnits.get(pageNumber);
			if (
				previousUnit?.status === "complete" &&
				previousUnit.textPath &&
				existsSync(previousUnit.textPath) &&
				(!includeImages || (previousUnit.imagePath && existsSync(previousUnit.imagePath)))
			) {
				const pageText = await readFile(previousUnit.textPath, "utf8");
				pageTexts.push(`[${pageLabel}]\n${pageText}`);
				units.push(previousUnit);
				if (includeImages && inlinePages.has(pageNumber) && previousUnit.imagePath) {
					images.push({
						type: "image",
						data: (await readFile(previousUnit.imagePath)).toString("base64"),
						mimeType: "image/png",
					});
				}
				continue;
			}
			try {
				const page = await document.getPage(pageNumber);
				const textContent = await page.getTextContent();
				const pageText = textContent.items
					.filter((item): item is Extract<(typeof textContent.items)[number], { str: string }> => "str" in item)
					.map((item) => item.str)
					.join(" ")
					.trim();
				await writeFile(textPath, pageText, "utf8");
				pageTexts.push(`[${pageLabel}]\n${pageText}`);

				let storedImagePath: string | undefined;
				if (includeImages) {
					const viewport = page.getViewport({ scale: 1.5 });
					if (viewport.width * viewport.height > MAX_IMAGE_PIXELS) {
						throw new Error("PDF 页面像素数量超过安全上限");
					}
					const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
					const renderTask = page.render({
						canvas: canvas as unknown as RenderParameters["canvas"],
						viewport,
					});
					const cancelRender = () => renderTask.cancel();
					signal?.addEventListener("abort", cancelRender, { once: true });
					try {
						await renderTask.promise;
					} finally {
						signal?.removeEventListener("abort", cancelRender);
					}
					const converted = await toImageContent(
						canvas.toBuffer("image/png"),
						"image/png",
						autoResizeImages,
						signal,
					);
					if (!converted.image) throw new Error(converted.error ?? "PDF 页面图像转换失败");
					await writeFile(imagePath, Buffer.from(converted.image.data, "base64"));
					storedImagePath = imagePath;
					if (inlinePages.has(pageNumber)) images.push(converted.image);
				}
				units.push({
					unitNumber: pageNumber,
					label: pageLabel,
					status: "complete",
					textPath,
					imagePath: storedImagePath,
				});
			} catch (error) {
				if (isAbortError(error, signal)) throw error;
				const message = error instanceof Error ? error.message : String(error);
				failedPages.push(pageNumber);
				units.push({
					unitNumber: pageNumber,
					label: pageLabel,
					status: "failed",
					textPath: existsSync(textPath) ? textPath : undefined,
					imagePath: existsSync(imagePath) ? imagePath : undefined,
					error: message,
				});
			}
			manifest.units = [...units];
			manifest.completedUnits = units.filter((unit) => unit.status === "complete").length;
			manifest.failedUnits = units.filter((unit) => unit.status === "failed").map((unit) => unit.unitNumber);
			manifest.updatedAt = Date.now();
			await writeDocumentCorpusManifest(corpusPaths.manifestPath, manifest);
		}
		const notes = [
			includeImages
				? `PDF 共 ${document.numPages} 页，已提取全部页面文字并渲染 ${units.filter((unit) => unit.imagePath).length} 页；全部页面按文件名和页码写入持久化资料库。`
				: `PDF 共 ${document.numPages} 页，已提取全部页面文字；当前未渲染页面图片。`,
		];
		if (document.numPages > images.length && images.length > 0) {
			notes.push(`当前消息只附带 ${images.length} 个页面预览；Vision Assistant 将根据逐页清单处理全部页面。`);
		}
		if (failedPages.length > 0) notes.push(`第 ${failedPages.join("、")} 页处理失败，可在下次读取时单独重试。`);
		const extractedText = pageTexts.join("\n\n");
		await writeFile(corpusPaths.fullTextPath, `${extractedText}\n`, "utf8");
		manifest.units = units;
		manifest.completedUnits = units.filter((unit) => unit.status === "complete").length;
		manifest.failedUnits = units.filter((unit) => unit.status === "failed").map((unit) => unit.unitNumber);
		manifest.status = manifest.failedUnits.length > 0 ? "partial" : "complete";
		manifest.updatedAt = Date.now();
		await writeDocumentCorpusManifest(corpusPaths.manifestPath, manifest);
		const corpusNotice = formatDocumentCorpusNotice(manifest, corpusPaths.manifestPath);
		const fullText = `${notes.join("\n")}\n\n${corpusNotice}${extractedText ? `\n\n${limitText(extractedText)}` : ""}`;
		return {
			kind: "pdf",
			text: fullText,
			fullText,
			images,
			documentManifestPath: corpusPaths.manifestPath,
			documentCorpusNotice: corpusNotice,
		};
	} catch (error) {
		if (isAbortError(error, signal)) throw error;
		return { kind: "pdf", text: errorText("PDF", error), images: [] };
	} finally {
		signal?.removeEventListener("abort", abortLoading);
		await loadingTask?.destroy();
	}
}

function parseDurationInSeconds(output: string): number | undefined {
	const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
	if (!match) return undefined;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	const duration = hours * 3600 + minutes * 60 + seconds;
	return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function selectVideoTimestamps(duration: number | undefined): number[] {
	if (!duration) return [0];
	const count = Math.min(MAX_VIDEO_FRAMES, Math.max(2, Math.ceil(duration / 10)));
	return Array.from({ length: count }, (_, index) => {
		if (count === 1) return 0;
		return Math.max(0, Math.min(duration - 0.05, (duration * index) / (count - 1)));
	});
}

async function preprocessVideo(
	filePath: string,
	autoResizeImages: boolean,
	includeImages: boolean,
	signal?: AbortSignal,
): Promise<PreprocessedLocalFile> {
	if (!includeImages) {
		return { kind: "video", text: "[当前已关闭图片处理，因此没有抽取视频关键帧。]", images: [] };
	}
	const ffmpegPath = getFfmpegPath();
	if (!ffmpegPath) {
		return { kind: "video", text: "[视频预处理失败：当前平台没有可用的 FFmpeg。]", images: [] };
	}
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "myharness-video-"));
	try {
		const probeOutput = await runProcess(
			ffmpegPath,
			["-hide_banner", "-i", filePath, "-t", "0.001", "-f", "null", "-"],
			15_000,
			signal,
		);
		const duration = parseDurationInSeconds(probeOutput);
		const timestamps = selectVideoTimestamps(duration);
		const images: ImageContent[] = [];
		const failedFrames: number[] = [];
		for (let index = 0; index < timestamps.length; index++) {
			throwIfAborted(signal);
			const outputPath = join(temporaryDirectory, `frame-${String(index + 1).padStart(2, "0")}.png`);
			try {
				await runProcess(
					ffmpegPath,
					[
						"-hide_banner",
						"-loglevel",
						"error",
						"-ss",
						timestamps[index].toFixed(3),
						"-i",
						filePath,
						"-frames:v",
						"1",
						"-vf",
						"scale=min(1600\\,iw):-2",
						"-y",
						outputPath,
					],
					CONVERSION_TIMEOUT_MS,
					signal,
				);
				const converted = await toImageContent(
					await readFile(outputPath, { signal }),
					"image/png",
					autoResizeImages,
					signal,
				);
				if (converted.image) images.push(converted.image);
				else failedFrames.push(index + 1);
			} catch (error) {
				if (isAbortError(error, signal)) throw error;
				failedFrames.push(index + 1);
			}
		}
		const notes = [
			`已从视频${duration ? `（${duration.toFixed(1)} 秒）` : ""}中抽取 ${images.length} 个关键帧。`,
			"未处理音轨。",
		];
		if (failedFrames.length > 0) notes.push(`第 ${failedFrames.join("、")} 个关键帧提取失败。`);
		return { kind: "video", text: notes.join("\n"), images };
	} catch (error) {
		if (isAbortError(error, signal)) throw error;
		return { kind: "video", text: errorText("视频", error), images: [] };
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

/**
 * Converts supported local binary files into text and/or regular inline image attachments.
 * Returns null for ordinary text files so callers can keep their existing text-reading behavior.
 */
export async function preprocessLocalFile(
	filePath: string,
	options?: PreprocessLocalFileOptions,
): Promise<PreprocessedLocalFile | null> {
	const extension = getExtension(filePath);
	const autoResizeImages = options?.autoResizeImages ?? true;
	const includeImages = options?.includeImages ?? true;
	const signal = options?.signal;
	const documentCorpusDirectory = options?.documentCorpusDirectory;
	throwIfAborted(signal);
	const stats = await stat(filePath);
	const directlySupportedMimeType = await detectSupportedImageMimeTypeFromFile(filePath);
	const inputLimit =
		options?.maxInputBytes ??
		maximumInputBytes(extension) ??
		(directlySupportedMimeType ? DEFAULT_MAX_IMAGE_INPUT_BYTES : undefined);
	if (inputLimit !== undefined && stats.size > inputLimit) {
		return {
			kind: PDF_EXTENSIONS.has(extension)
				? "pdf"
				: OFFICE_EXTENSIONS.has(extension)
					? "document"
					: VIDEO_EXTENSIONS.has(extension)
						? "video"
						: "image",
			text: `[文件未处理：大小为 ${formatInputLimit(stats.size)}，超过当前 ${formatInputLimit(inputLimit)} 的单文件安全上限。请拆分文件，或通过调用参数明确提高上限。]`,
			images: [],
		};
	}
	const cacheKey = `${filePath}\0${stats.size}\0${stats.mtimeMs}\0${autoResizeImages}\0${includeImages}\0${documentCorpusDirectory ?? ""}`;
	const cached = preprocessCache.get(filePath);
	if (cached?.key === cacheKey) {
		preprocessCache.delete(filePath);
		preprocessCache.set(filePath, cached);
		return clonePreprocessedResult(cached.result);
	}
	let result: PreprocessedLocalFile | null;
	if (
		!includeImages &&
		(directlySupportedMimeType ||
			RASTER_IMAGE_EXTENSIONS.has(extension) ||
			SVG_EXTENSIONS.has(extension) ||
			PSD_EXTENSIONS.has(extension))
	) {
		result = { kind: "image", text: "[当前已关闭图片处理，因此没有读取图片内容。]", images: [] };
	} else if (directlySupportedMimeType) result = await preprocessImage(filePath, extension, autoResizeImages, signal);
	else if (RASTER_IMAGE_EXTENSIONS.has(extension) || SVG_EXTENSIONS.has(extension) || PSD_EXTENSIONS.has(extension)) {
		result = await preprocessImage(filePath, extension, autoResizeImages, signal);
	} else if (PDF_EXTENSIONS.has(extension)) {
		result = await preprocessPdf(filePath, autoResizeImages, includeImages, signal, documentCorpusDirectory);
	} else if (OFFICE_EXTENSIONS.has(extension)) {
		result = await preprocessOfficeDocument(
			filePath,
			autoResizeImages,
			includeImages,
			signal,
			documentCorpusDirectory,
		);
	} else if (VIDEO_EXTENSIONS.has(extension)) {
		result = await preprocessVideo(filePath, autoResizeImages, includeImages, signal);
	} else if (AUDIO_EXTENSIONS.has(extension)) {
		result = {
			kind: "unsupported",
			text: "[当前未启用音频处理。请提供文字转录，或先把音频转成文字。]",
			images: [],
		};
	} else if (LEGACY_OFFICE_EXTENSIONS.has(extension)) {
		result = {
			kind: "unsupported",
			text: `[暂不支持旧版 ${extension.slice(1).toUpperCase()} 二进制格式。请先另存为 DOCX、XLSX 或 PPTX。]`,
			images: [],
		};
	} else {
		result = null;
	}
	throwIfAborted(signal);
	const resultSize = estimatePreprocessedSize(result);
	const previous = preprocessCache.get(filePath);
	if (previous) preprocessCacheBytes -= previous.size;
	preprocessCache.delete(filePath);
	if (resultSize <= PREPROCESS_CACHE_MAX_ENTRY_BYTES) {
		preprocessCache.set(filePath, { key: cacheKey, result: clonePreprocessedResult(result), size: resultSize });
		preprocessCacheBytes += resultSize;
	}
	while (
		preprocessCache.size > PREPROCESS_CACHE_ENTRIES ||
		(preprocessCacheBytes > PREPROCESS_CACHE_MAX_BYTES && preprocessCache.size > 0)
	) {
		const oldestKey = preprocessCache.keys().next().value;
		if (oldestKey) {
			const oldest = preprocessCache.get(oldestKey);
			if (oldest) preprocessCacheBytes -= oldest.size;
			preprocessCache.delete(oldestKey);
		} else break;
	}
	return result;
}
