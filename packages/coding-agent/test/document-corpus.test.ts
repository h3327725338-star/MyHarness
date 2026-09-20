import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDocumentCollectionManifest,
	createDocumentCorpusManifest,
	DOCUMENT_CORPUS_VERSION,
	getDocumentCorpusPaths,
	isSameDocumentSource,
	MAX_DOCUMENT_MANIFEST_BYTES,
	readDocumentCollectionManifest,
	readDocumentCorpusManifest,
	writeDocumentCorpusManifest,
} from "../src/agent/vision/document-corpus.ts";

let tempDir = "";

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = "";
});

function createTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "myharness-document-corpus-"));
	return tempDir;
}

describe("document corpus source identity", () => {
	it("collapses Windows path casing on Windows and preserves it elsewhere", () => {
		const directory = createTempDir();
		const upper = join(directory, "Docs", "Report.pdf");
		const lower = upper.toLowerCase();
		const upperRoot = getDocumentCorpusPaths(upper, 10, 20, join(directory, "corpus")).root;
		const lowerRoot = getDocumentCorpusPaths(lower, 10, 20, join(directory, "corpus")).root;

		if (process.platform === "win32") {
			expect(lower).not.toBe(upper);
			expect(lowerRoot).toBe(upperRoot);
			expect(isSameDocumentSource(upper, lower)).toBe(true);
		} else {
			expect(lowerRoot).not.toBe(upperRoot);
			expect(isSameDocumentSource(upper, lower)).toBe(false);
		}
	});

	it("keeps distinct documents distinct when only the content metadata differs", () => {
		const directory = createTempDir();
		const first = getDocumentCorpusPaths(join(directory, "a.pdf"), 1, 2, join(directory, "corpus"));
		const second = getDocumentCorpusPaths(join(directory, "a.pdf"), 1, 3, join(directory, "corpus"));
		expect(second.root).not.toBe(first.root);
	});
});

describe("document corpus manifest reads", () => {
	it("round-trips a corpus manifest", async () => {
		const directory = createTempDir();
		const sourcePath = join(directory, "sample.pdf");
		writeFileSync(sourcePath, "x");
		const paths = getDocumentCorpusPaths(sourcePath, 1, 2, join(directory, "corpus"));
		const manifest = createDocumentCorpusManifest(sourcePath, 1, 2, "pdf", 1, paths);
		await writeDocumentCorpusManifest(paths.manifestPath, manifest);

		const loaded = await readDocumentCorpusManifest(paths.manifestPath);
		expect(loaded?.documentId).toBe(manifest.documentId);
		expect(loaded?.accessToken).toBe(manifest.accessToken);
	});

	it("returns undefined for missing and malformed manifests", async () => {
		const directory = createTempDir();
		await expect(readDocumentCorpusManifest(join(directory, "missing.json"))).resolves.toBeUndefined();
		const malformed = join(directory, "malformed.json");
		writeFileSync(malformed, "{ not json");
		await expect(readDocumentCorpusManifest(malformed)).resolves.toBeUndefined();
	});

	it("refuses to read a manifest above the size limit", async () => {
		const directory = createTempDir();
		const oversized = join(directory, "oversized.json");
		writeFileSync(oversized, "");
		truncateSync(oversized, MAX_DOCUMENT_MANIFEST_BYTES + 1);
		await expect(readDocumentCorpusManifest(oversized)).resolves.toBeUndefined();

		await expect(readDocumentCollectionManifest({ path: oversized, accessToken: "token" })).resolves.toBeUndefined();
	});

	it("keeps collection manifest token validation", async () => {
		const directory = createTempDir();
		const documentPath = join(directory, "a.pdf");
		writeFileSync(documentPath, "x");
		const { manifest, path } = await createDocumentCollectionManifest(
			[{ path: documentPath, accessToken: "doc-token" }],
			join(directory, "collections"),
		);
		expect(manifest.version).toBe(DOCUMENT_CORPUS_VERSION);
		await expect(readDocumentCollectionManifest({ path, accessToken: manifest.accessToken })).resolves.toBeDefined();
		await expect(readDocumentCollectionManifest({ path, accessToken: "wrong-token" })).resolves.toBeUndefined();
	});
});
