import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionConversationPath } from "../../src/config/paths/index.ts";
import { projectSession } from "../../src/exports/html/replay/project.ts";
import { clearParseCache, SessionManager } from "../../src/session/manager/index.ts";
import {
	imageBase64Length,
	imageForDisplay,
	readImageBytes,
	SESSION_IMAGE_FILE_MIN_BASE64,
	storedSessionImage,
} from "../../src/session/storage/jsonl/image-files.ts";
import {
	loadEntriesFromFile,
	relocateSessionFile,
	rewriteSessionFile,
	writeSessionFile,
} from "../../src/session/storage/jsonl/index.ts";
import { loadSessionTail } from "../../src/session/storage/jsonl/tail-window.ts";
import type { FileEntry } from "../../src/session/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	clearParseCache();
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "myharness-image-files-"));
	roots.push(root);
	return root;
}

function conversationFile(dataRoot: string, sessionId = "session-a", workspaceId = "workspace-a"): string {
	const file = getSessionConversationPath(dataRoot, workspaceId, sessionId, "chat.jsonl");
	mkdirSync(join(file, ".."), { recursive: true });
	return file;
}

/** Canonical base64 above the file threshold (the store never looks at the image format). */
function largeImageData(): string {
	const data = randomBytes(Math.ceil((SESSION_IMAGE_FILE_MIN_BASE64 * 3) / 4) + 300).toString("base64");
	expect(data.length).toBeGreaterThanOrEqual(SESSION_IMAGE_FILE_MIN_BASE64);
	return data;
}

function header(id: string): FileEntry {
	return { type: "session", version: 3, id, timestamp: new Date(1000).toISOString(), cwd: tmpdir() } as FileEntry;
}

function toolResult(id: string, parentId: string | null, images: Array<{ data: string; mimeType: string }>): FileEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(2000).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: "read",
			content: [{ type: "text", text: "pages" }, ...images.map((image) => ({ type: "image", ...image }))],
			isError: false,
			timestamp: 2000,
		},
	} as unknown as FileEntry;
}

function imagesOf(entry: FileEntry): Array<{ type: "image"; data: string; mimeType: string }> {
	const content = (entry as { message?: { content?: unknown } }).message?.content;
	return (Array.isArray(content) ? content : []).filter(
		(part): part is { type: "image"; data: string; mimeType: string } => part?.type === "image",
	);
}

function imageDir(file: string): string {
	return join(file, "..", "images");
}

describe("Session images stored as files", () => {
	it("writes a large image once as a file, keeps small images inline, and reads the same data back", () => {
		const file = conversationFile(tempRoot());
		const big = largeImageData();
		const small = randomBytes(100).toString("base64");
		writeSessionFile(file, [
			header("session-a"),
			toolResult("e1", null, [
				{ data: big, mimeType: "image/jpeg" },
				{ data: small, mimeType: "image/png" },
			]),
			toolResult("e2", "e1", [{ data: big, mimeType: "image/jpeg" }]),
		]);

		const text = readFileSync(file, "utf8");
		expect(text).not.toContain(big);
		expect(text).toContain(small);
		expect(text).toContain('"sessionImageFile"');
		const files = readdirSync(imageDir(file));
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^[0-9a-f]{64}\.jpg$/);
		expect(readFileSync(join(imageDir(file), files[0]!)).toString("base64")).toBe(big);

		clearParseCache();
		const entries = loadEntriesFromFile(file);
		const [first, second] = [imagesOf(entries[1]!), imagesOf(entries[2]!)];
		expect(first[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
		expect(first[0]!.data).toBe(big);
		expect(first[1]).toEqual({ type: "image", data: small, mimeType: "image/png" });
		expect(second[0]!.data).toBe(big);
		// What a model adapter or an export would see: a plain image block, nothing extra.
		expect(JSON.parse(JSON.stringify(first[0]))).toEqual({ type: "image", data: big, mimeType: "image/jpeg" });
	});

	it("leaves an older reader a valid placeholder image instead of an empty block", () => {
		const file = conversationFile(tempRoot());
		writeSessionFile(file, [
			header("session-a"),
			toolResult("e1", null, [{ data: largeImageData(), mimeType: "image/webp" }]),
		]);
		const raw = JSON.parse(readFileSync(file, "utf8").split("\n")[1]!) as FileEntry;
		const [image] = imagesOf(raw);
		expect(image!.mimeType).toBe("image/png");
		expect(Buffer.from(image!.data, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
	});

	it("does not read the file when the chat is loaded, measured, or rewritten", () => {
		const file = conversationFile(tempRoot());
		const big = largeImageData();
		writeSessionFile(file, [header("session-a"), toolResult("e1", null, [{ data: big, mimeType: "image/png" }])]);
		clearParseCache();
		const entries = loadEntriesFromFile(file);
		const image = imagesOf(entries[1]!)[0]!;
		// With the file gone, only something that really needs the bytes notices.
		rmSync(imageDir(file), { recursive: true, force: true });
		expect(imageBase64Length(image)).toBe(big.length);
		expect(imageBase64Length(imageForDisplay(image))).toBe(big.length);
		rewriteSessionFile(file, entries);
		expect(readFileSync(file, "utf8")).toContain('"sessionImageFile"');

		// A missing file answers a same-type placeholder and is tried again on the next read.
		const placeholder = image.data;
		expect(placeholder).not.toBe(big);
		expect(Buffer.from(placeholder, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		const stored = storedSessionImage(image)!;
		mkdirSync(imageDir(file), { recursive: true });
		writeFileSync(stored.file, Buffer.from(big, "base64"));
		expect(image.data).toBe(big);
	});

	it("serves the image bytes from the file", async () => {
		const file = conversationFile(tempRoot());
		const big = largeImageData();
		writeSessionFile(file, [header("session-a"), toolResult("e1", null, [{ data: big, mimeType: "image/png" }])]);
		clearParseCache();
		const image = imagesOf(loadEntriesFromFile(file)[1]!)[0]!;
		expect((await readImageBytes(image)).toString("base64")).toBe(big);
	});

	it("stores a replaced image again instead of pointing at the old file", () => {
		const file = conversationFile(tempRoot());
		writeSessionFile(file, [
			header("session-a"),
			toolResult("e1", null, [{ data: largeImageData(), mimeType: "image/png" }]),
		]);
		clearParseCache();
		const entries = loadEntriesFromFile(file);
		const image = imagesOf(entries[1]!)[0]!;
		const replacement = largeImageData();
		image.data = replacement;
		expect(storedSessionImage(image)).toBeUndefined();
		rewriteSessionFile(file, entries);
		clearParseCache();
		expect(imagesOf(loadEntriesFromFile(file)[1]!)[0]!.data).toBe(replacement);
		expect(readdirSync(imageDir(file))).toHaveLength(2);
	});

	it("keeps images inline outside a structured Session folder and for non-canonical base64", () => {
		const root = tempRoot();
		const flat = join(root, "flat.jsonl");
		const big = largeImageData();
		writeSessionFile(flat, [header("flat"), toolResult("e1", null, [{ data: big, mimeType: "image/png" }])]);
		expect(readFileSync(flat, "utf8")).toContain(big);
		expect(existsSync(join(root, "images"))).toBe(false);

		const file = conversationFile(root);
		const wrapped = `${big.slice(0, 76)}\n${big.slice(76)}`;
		writeSessionFile(file, [header("session-a"), toolResult("e1", null, [{ data: wrapped, mimeType: "image/png" }])]);
		clearParseCache();
		expect(imagesOf(loadEntriesFromFile(file)[1]!)[0]!.data).toBe(wrapped);
	});

	it("copies the files into a fork, which keeps working after the source chat is gone", () => {
		const dataRoot = tempRoot();
		const source = conversationFile(dataRoot, "source");
		const big = largeImageData();
		writeSessionFile(source, [header("source"), toolResult("e1", null, [{ data: big, mimeType: "image/png" }])]);
		clearParseCache();
		const fork = SessionManager.forkFrom(source, tmpdir(), undefined, undefined, { dataRoot });
		const forkFile = fork.getSessionFile()!;
		expect(readFileSync(forkFile, "utf8")).not.toContain(big);
		rmSync(join(source, "..", ".."), { recursive: true, force: true });
		clearParseCache();
		const image = imagesOf(loadEntriesFromFile(forkFile).find((entry) => entry.type === "message")!)[0]!;
		expect(image.data).toBe(big);
	});

	it("moves the files along when a chat moves to another Session folder", () => {
		const dataRoot = tempRoot();
		const source = conversationFile(dataRoot, "moving", "workspace-a");
		const target = conversationFile(dataRoot, "moving", "workspace-b");
		const big = largeImageData();
		writeSessionFile(source, [header("moving"), toolResult("e1", null, [{ data: big, mimeType: "image/png" }])]);
		clearParseCache();
		const entries = loadEntriesFromFile(source);
		relocateSessionFile({ sourceFile: source, targetFile: target, entries, flushed: true });
		expect(existsSync(source)).toBe(false);
		// The old folder keeps nothing that would stop it from being cleaned up.
		expect(existsSync(imageDir(source))).toBe(false);
		clearParseCache();
		expect(imagesOf(loadEntriesFromFile(target)[1]!)[0]!.data).toBe(big);
	});

	it("keeps the offline replay export self-contained", () => {
		const file = conversationFile(tempRoot());
		const big = largeImageData();
		writeSessionFile(file, [header("session-a"), toolResult("e1", null, [{ data: big, mimeType: "image/png" }])]);
		clearParseCache();
		const projection = projectSession(file);
		expect(projection.rawJsonl).toContain(big);
		expect(projection.rawJsonl).not.toContain('"sessionImageFile"');
	});

	it("restores images in the tail window", () => {
		const file = conversationFile(tempRoot());
		const big = largeImageData();
		writeSessionFile(file, [header("session-a"), toolResult("e1", null, [{ data: big, mimeType: "image/gif" }])]);
		clearParseCache();
		const tail = loadSessionTail(file);
		const image = imagesOf(tail.entries.at(-1)!)[0]!;
		expect(image.mimeType).toBe("image/gif");
		expect(image.data).toBe(big);
	});

	it("moves an older chat's inline images into files once it owns the Session", async () => {
		const file = conversationFile(tempRoot());
		const big = largeImageData();
		const lines = [
			header("session-a"),
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: new Date(1500).toISOString(),
				message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1500 },
			},
			toolResult("e1", "a1", [{ data: big, mimeType: "image/png" }]),
		];
		// Written the way older versions did: plain JSON lines with the base64 inline.
		writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
		const manager = SessionManager.open(file);
		expect(manager.acquireWriterLock()).toBe("owner");
		try {
			const deadline = Date.now() + 10_000;
			while (readFileSync(file, "utf8").includes(big) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const text = readFileSync(file, "utf8");
			expect(text).not.toContain(big);
			expect(text).toContain('"sessionImageFile"');
			// The live manager still has the image, and a fresh load reads the same bytes.
			const live = imagesOf(manager.getEntry("e1") as FileEntry)[0]!;
			expect(live.data).toBe(big);
			clearParseCache();
			expect(imagesOf(loadEntriesFromFile(file)[2]!)[0]!.data).toBe(big);
		} finally {
			manager.releaseWriterLock();
		}
	});
});
