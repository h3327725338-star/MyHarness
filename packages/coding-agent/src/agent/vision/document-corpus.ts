import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "../../config.ts";

export const DOCUMENT_CORPUS_VERSION = 1;
export const DOCUMENT_MANIFEST_MARKER = "myharness-document-manifest";
export const DOCUMENT_COLLECTION_MARKER = "myharness-document-collection";

/**
 * Upper bound for manifest reads. Manifest paths can come from
 * user-visible prompt markers, so an unbounded read would let a crafted
 * marker pull an arbitrarily large local file into memory.
 */
export const MAX_DOCUMENT_MANIFEST_BYTES = 64 * 1024 * 1024;

export type DocumentCorpusKind = "pdf" | "document";
export type DocumentUnitStatus = "pending" | "complete" | "failed";
export type DocumentProcessingStatus = "pending" | "processing" | "complete" | "partial" | "failed" | "cancelled";

export interface DocumentCorpusUnit {
	unitNumber: number;
	label: string;
	status: DocumentUnitStatus;
	sourceType?: string;
	pageNumber?: number;
	slideNumber?: number;
	sheetName?: string;
	heading?: string;
	textPath?: string;
	imagePath?: string;
	error?: string;
}

export interface DocumentCorpusManifest {
	version: typeof DOCUMENT_CORPUS_VERSION;
	documentId: string;
	accessToken: string;
	sourcePath: string;
	sourceName: string;
	sourceSize: number;
	sourceMtimeMs: number;
	kind: DocumentCorpusKind;
	status: DocumentProcessingStatus;
	totalUnits: number;
	completedUnits: number;
	failedUnits: number[];
	processingError?: string;
	fullTextPath: string;
	visionReportPath: string;
	visionStatus?: DocumentProcessingStatus;
	visionCompletedUnits?: number;
	visionFailedUnits?: number[];
	visionError?: string;
	updatedAt: number;
	units: DocumentCorpusUnit[];
}

export interface DocumentCorpusPaths {
	root: string;
	manifestPath: string;
	fullTextPath: string;
	visionReportPath: string;
	textDirectory: string;
	imageDirectory: string;
	analysisDirectory: string;
}

/**
 * Resolve a source path to the identity used for corpus keys and reuse checks.
 *
 * Windows drive letters and path components are case-insensitive, so the same
 * file referenced as `C:\Docs\Report.pdf` and `c:/docs/report.pdf` must map to
 * one corpus. On case-sensitive platforms the real casing is preserved so two
 * distinct files never collapse into one corpus.
 */
function canonicalSourcePath(sourcePath: string): string {
	const resolved = resolve(sourcePath).replace(/\\/g, "/");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when two source paths refer to the same document on this platform. */
export function isSameDocumentSource(leftPath: string, rightPath: string): boolean {
	return canonicalSourcePath(leftPath) === canonicalSourcePath(rightPath);
}

function stableDocumentId(sourcePath: string, sourceSize: number, sourceMtimeMs: number): string {
	return createHash("sha256")
		.update(canonicalSourcePath(sourcePath))
		.update("\0")
		.update(String(sourceSize))
		.update("\0")
		.update(String(sourceMtimeMs))
		.digest("hex")
		.slice(0, 24);
}

/**
 * Read and parse a JSON manifest while refusing to materialize more than
 * `MAX_DOCUMENT_MANIFEST_BYTES`. Returns undefined for missing, oversized, or
 * malformed manifests.
 */
async function readJsonManifest(path: string): Promise<unknown | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		const stats = await handle.stat();
		if (stats.size > MAX_DOCUMENT_MANIFEST_BYTES) return undefined;
		const buffer = Buffer.alloc(stats.size);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
	} catch {
		return undefined;
	} finally {
		await handle?.close();
	}
}

export function getDocumentCorpusPaths(
	sourcePath: string,
	sourceSize: number,
	sourceMtimeMs: number,
	corpusDirectory = join(getAgentDir(), "document-corpus"),
): DocumentCorpusPaths {
	const documentId = stableDocumentId(sourcePath, sourceSize, sourceMtimeMs);
	const root = join(corpusDirectory, documentId);
	return {
		root,
		manifestPath: join(root, "manifest.json"),
		fullTextPath: join(root, "fulltext.md"),
		visionReportPath: join(root, "vision-report.md"),
		textDirectory: join(root, "pages"),
		imageDirectory: join(root, "images"),
		analysisDirectory: join(root, "analysis"),
	};
}

export async function prepareDocumentCorpusDirectories(paths: DocumentCorpusPaths): Promise<void> {
	await Promise.all([
		mkdir(paths.root, { recursive: true }),
		mkdir(paths.textDirectory, { recursive: true }),
		mkdir(paths.imageDirectory, { recursive: true }),
		mkdir(paths.analysisDirectory, { recursive: true }),
	]);
}

export async function readDocumentCorpusManifest(path: string): Promise<DocumentCorpusManifest | undefined> {
	const raw = await readJsonManifest(path);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const parsed = raw as Partial<DocumentCorpusManifest>;
	if (
		parsed.version !== DOCUMENT_CORPUS_VERSION ||
		typeof parsed.documentId !== "string" ||
		typeof parsed.accessToken !== "string" ||
		typeof parsed.sourcePath !== "string" ||
		!Array.isArray(parsed.units) ||
		!parsed.units.every(
			(unit) =>
				unit !== null &&
				typeof unit === "object" &&
				Number.isInteger(unit.unitNumber) &&
				unit.unitNumber > 0 &&
				typeof unit.label === "string" &&
				(unit.status === "pending" || unit.status === "complete" || unit.status === "failed"),
		)
	) {
		return undefined;
	}
	return parsed as DocumentCorpusManifest;
}

export async function writeDocumentCorpusManifest(path: string, manifest: DocumentCorpusManifest): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	await rename(temporaryPath, path);
}

export function createDocumentCorpusManifest(
	sourcePath: string,
	sourceSize: number,
	sourceMtimeMs: number,
	kind: DocumentCorpusKind,
	totalUnits: number,
	paths: DocumentCorpusPaths,
): DocumentCorpusManifest {
	const documentId = basename(paths.root);
	return {
		version: DOCUMENT_CORPUS_VERSION,
		documentId,
		accessToken: randomUUID(),
		sourcePath: resolve(sourcePath),
		sourceName: basename(sourcePath),
		sourceSize,
		sourceMtimeMs,
		kind,
		status: "pending",
		totalUnits,
		completedUnits: 0,
		failedUnits: [],
		visionStatus: "pending",
		visionCompletedUnits: 0,
		visionFailedUnits: [],
		fullTextPath: paths.fullTextPath,
		visionReportPath: paths.visionReportPath,
		updatedAt: Date.now(),
		units: [],
	};
}

export interface DocumentManifestReference {
	path: string;
	accessToken: string;
}

export interface DocumentCollectionManifest {
	version: typeof DOCUMENT_CORPUS_VERSION;
	collectionId: string;
	accessToken: string;
	createdAt: number;
	documents: DocumentManifestReference[];
}

export function formatDocumentManifestMarker(manifestPath: string, accessToken: string): string {
	const encodedReference = Buffer.from(JSON.stringify({ path: resolve(manifestPath), accessToken }), "utf8").toString(
		"base64url",
	);
	return `<${DOCUMENT_MANIFEST_MARKER}>${encodedReference}</${DOCUMENT_MANIFEST_MARKER}>`;
}

export function findDocumentManifestReferences(text: string): DocumentManifestReference[] {
	const expression = new RegExp(`<${DOCUMENT_MANIFEST_MARKER}>([A-Za-z0-9_-]+)</${DOCUMENT_MANIFEST_MARKER}>`, "g");
	const references: DocumentManifestReference[] = [];
	for (const match of text.matchAll(expression)) {
		const encoded = match[1];
		if (!encoded) continue;
		try {
			const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
				path?: unknown;
				accessToken?: unknown;
			};
			if (typeof parsed.path === "string" && typeof parsed.accessToken === "string") {
				references.push({ path: resolve(parsed.path), accessToken: parsed.accessToken });
			}
		} catch {
			// Ignore malformed prompt markers. They are untrusted user-visible text.
		}
	}
	return [
		...new Map(references.map((reference) => [`${reference.path}\0${reference.accessToken}`, reference])).values(),
	];
}

export async function createDocumentCollectionManifest(
	documents: DocumentManifestReference[],
	collectionDirectory = join(getAgentDir(), "document-corpus", "collections"),
): Promise<{ manifest: DocumentCollectionManifest; path: string }> {
	const uniqueDocuments = [
		...new Map(
			documents.map((document) => [`${resolve(document.path)}\0${document.accessToken}`, document]),
		).values(),
	];
	const collectionId = createHash("sha256")
		.update(
			uniqueDocuments
				.map((document) => `${resolve(document.path)}:${document.accessToken}`)
				.sort()
				.join("\n"),
		)
		.digest("hex")
		.slice(0, 24);
	const path = join(collectionDirectory, `${collectionId}.json`);
	try {
		const previous = JSON.parse(await readFile(path, "utf8")) as Partial<DocumentCollectionManifest>;
		if (
			previous.version === DOCUMENT_CORPUS_VERSION &&
			previous.collectionId === collectionId &&
			typeof previous.accessToken === "string" &&
			Array.isArray(previous.documents)
		) {
			return { manifest: previous as DocumentCollectionManifest, path };
		}
	} catch {
		// Create a new immutable collection index.
	}
	const manifest: DocumentCollectionManifest = {
		version: DOCUMENT_CORPUS_VERSION,
		collectionId,
		accessToken: randomUUID(),
		createdAt: Date.now(),
		documents: uniqueDocuments,
	};
	await mkdir(collectionDirectory, { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	await rename(temporaryPath, path);
	return { manifest, path };
}

export function formatDocumentCollectionMarker(path: string, accessToken: string): string {
	const encodedReference = Buffer.from(JSON.stringify({ path: resolve(path), accessToken }), "utf8").toString(
		"base64url",
	);
	return `<${DOCUMENT_COLLECTION_MARKER}>${encodedReference}</${DOCUMENT_COLLECTION_MARKER}>`;
}

export function findDocumentCollectionReferences(text: string): DocumentManifestReference[] {
	const expression = new RegExp(
		`<${DOCUMENT_COLLECTION_MARKER}>([A-Za-z0-9_-]+)</${DOCUMENT_COLLECTION_MARKER}>`,
		"g",
	);
	const references: DocumentManifestReference[] = [];
	for (const match of text.matchAll(expression)) {
		const encoded = match[1];
		if (!encoded) continue;
		try {
			const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
				path?: unknown;
				accessToken?: unknown;
			};
			if (typeof parsed.path === "string" && typeof parsed.accessToken === "string") {
				references.push({ path: resolve(parsed.path), accessToken: parsed.accessToken });
			}
		} catch {
			// Ignore malformed, untrusted prompt markers.
		}
	}
	return references;
}

export async function readDocumentCollectionManifest(
	reference: DocumentManifestReference,
): Promise<DocumentCollectionManifest | undefined> {
	const raw = await readJsonManifest(reference.path);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const parsed = raw as Partial<DocumentCollectionManifest>;
	if (
		parsed.version !== DOCUMENT_CORPUS_VERSION ||
		parsed.accessToken !== reference.accessToken ||
		typeof parsed.collectionId !== "string" ||
		!Array.isArray(parsed.documents)
	) {
		return undefined;
	}
	return parsed as DocumentCollectionManifest;
}

export function formatDocumentCollectionNotice(manifest: DocumentCollectionManifest, path: string): string {
	const corpusRoot = dirname(dirname(resolve(path)));
	return [
		`[完整文档集合：${manifest.documents.length} 个文档]`,
		`集合 ID：${manifest.collectionId}`,
		`集合清单：${path}`,
		`全文检索目录：${corpusRoot}`,
		"集合清单保存了每个文档的逐页清单、完整原文路径和视觉转写路径。先用 Grep 在全文检索目录的 fulltext.md 中查找关键词，再用 Read 分段读取命中文档；不得仅依据集合通知作答。",
		formatDocumentCollectionMarker(path, manifest.accessToken),
	].join("\n");
}

export function formatDocumentCorpusNotice(manifest: DocumentCorpusManifest, manifestPath: string): string {
	const failed = manifest.failedUnits.length > 0 ? `，失败单元：${manifest.failedUnits.join("、")}` : "";
	return [
		`[完整文档资料库：${manifest.sourceName}]`,
		`文档 ID：${manifest.documentId}`,
		`处理进度：${manifest.completedUnits}/${manifest.totalUnits}${failed}`,
		`完整原文：${manifest.fullTextPath}`,
		`逐页清单：${manifestPath}`,
		`视觉转写：${manifest.visionReportPath}`,
		"主 AI 应以完整原文为事实依据；摘要仅用于导航。需要精确判断时，使用 Read 分段读取完整原文并按文件名、页码引用。",
		formatDocumentManifestMarker(manifestPath, manifest.accessToken),
	].join("\n");
}
