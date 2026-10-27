import { createHash } from "node:crypto";
import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseSessionDataPath } from "../../../config/paths/index.ts";
import { writeFileAtomically, writeFileAtomicallySync } from "../../../utils/atomic-write.ts";

/**
 * Large images of a structured Session are stored once per content in `conversation/images/<sha256>.<ext>` instead of
 * inline base64 in the JSONL. A Session file with screenshots or rendered document pages used to be over 99% base64
 * (one was 137 MB for 63 lines), so every load, rewrite, index rebuild and sync read all of it.
 *
 * On disk such an image block keeps a valid 1x1 PNG in `data` (an older MyHarness that does not know the field still
 * reads a well-formed image) and names the file in `sessionImageFile`. When a line is loaded the block gets back its
 * real `mimeType` and a lazy `data`: the file is read the first time something needs the bytes (a model request, an
 * export), not when the chat opens. While the block still holds what the file holds it carries a hidden record of that
 * file, so writing the entry again (rewrite, relocation, fork) refers to the file instead of hashing the data again.
 */

/** Base64 length from which an image is stored as a file (the same cut as the transcript's by-address images). */
export const SESSION_IMAGE_FILE_MIN_BASE64 = 32 * 1024;
export const SESSION_IMAGE_DIR_NAME = "images";
const REF_KEY = "sessionImageFile";
const REF_MARKER = `"${REF_KEY}"`;
const MAX_WALK_DEPTH = 64;

const PLACEHOLDERS: Record<string, string> = {
	"image/png":
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
	"image/jpeg":
		"/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z",
	"image/gif": "R0lGODlhAQABAIAAAExpcf///yH5BAUAAAAALAAAAAABAAEAAAICTAEAOw==",
	"image/webp": "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=",
};

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/avif": "avif",
};

/** Where a loaded image block's bytes live. Present only while the block's data is exactly that file's content. */
export interface StoredSessionImage {
	file: string;
	sha256: string;
	mimeType: string;
	bytes: number;
}

/** The on-disk reference, `sessionImageFile` of an image block. */
interface SessionImageFileRef {
	v: 1;
	sha256: string;
	mimeType: string;
	bytes: number;
}

const STORED = Symbol("myharness.storedSessionImage");

type ImageBlock = Record<string | symbol, unknown> & { type: "image"; mimeType: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isImageBlock(value: unknown): value is ImageBlock {
	return isRecord(value) && !Array.isArray(value) && value.type === "image" && typeof value.mimeType === "string";
}

function placeholderData(mimeType: string): string {
	return PLACEHOLDERS[mimeType] ?? PLACEHOLDERS["image/png"]!;
}

function fileName(sha256: string, mimeType: string): string {
	return `${sha256}.${EXTENSIONS[mimeType] ?? "bin"}`;
}

function base64Length(bytes: number): number {
	return 4 * Math.ceil(bytes / 3);
}

function sameDirectory(a: string, b: string): boolean {
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Folder that holds the image files of a Session file (looked up for every Session file that refers to one). */
export function sessionImageDirFor(sessionFile: string): string {
	return join(dirname(sessionFile), SESSION_IMAGE_DIR_NAME);
}

/**
 * Folder new image files are written to, or undefined when this Session file keeps its images inline: only a
 * structured Session (`.../sessions/<id>/conversation/<file>.jsonl`) owns its folder, so deleting or moving the chat
 * takes its images along. Flat and custom Session folders are shared by many files and stay inline.
 */
function writableImageDir(sessionFile: string): string | undefined {
	return parseSessionDataPath(sessionFile) ? sessionImageDirFor(sessionFile) : undefined;
}

/** The stored file behind an image block, while its data is still that file's content. */
export function storedSessionImage(image: object): StoredSessionImage | undefined {
	return (image as Record<symbol, unknown>)[STORED] as StoredSessionImage | undefined;
}

/** Base64 length of an image's data without loading a stored file. */
export function imageBase64Length(image: { data: string }): number {
	const stored = storedSessionImage(image);
	return stored ? base64Length(stored.bytes) : image.data.length;
}

/** Whether the block has data to show, without loading a stored file. */
export function imageHasData(image: { data?: unknown }): boolean {
	return storedSessionImage(image) !== undefined || Boolean(image.data);
}

/**
 * `{ mimeType, data }` of an image block for display. A stored image keeps its lazy data and its file record, so a
 * caller that only needs the size or sends the image by address never loads the file.
 */
export function imageForDisplay(image: { mimeType: string; data: string }): { mimeType: string; data: string } {
	const stored = storedSessionImage(image);
	if (!stored) return { mimeType: image.mimeType, data: image.data };
	const copy = { mimeType: image.mimeType } as { mimeType: string; data: string };
	Object.defineProperty(copy, "data", { enumerable: true, configurable: true, get: () => image.data });
	Object.defineProperty(copy, STORED, { value: stored, enumerable: false, configurable: true });
	return copy;
}

/** The image's bytes: the stored file when there is one (no base64 round trip), otherwise the decoded data. */
export async function readImageBytes(image: { data: string }): Promise<Buffer> {
	const stored = storedSessionImage(image);
	if (stored) {
		try {
			const bytes = await readFile(stored.file);
			if (bytes.length === stored.bytes) return bytes;
		} catch {
			// Missing or unreadable: fall back to what the block itself answers (a placeholder when the file is gone).
		}
	}
	return Buffer.from(image.data, "base64");
}

function readStoredData(stored: StoredSessionImage): string | undefined {
	try {
		const bytes = readFileSync(stored.file);
		// A file of another size is not this image (a torn copy); never hand it to a model as if it were.
		return bytes.length === stored.bytes ? bytes.toString("base64") : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Give the block a lazy `data` backed by `stored`. A file that cannot be read yet (another device's sync has not
 * brought it, say) answers a 1x1 placeholder of the same type and is tried again on the next read. Assigning `data`
 * turns it back into a plain property and drops the file record, so the next write stores the new content.
 */
function attachStoredImage(block: ImageBlock, stored: StoredSessionImage, loaded?: string): boolean {
	let value = loaded;
	try {
		Object.defineProperty(block, "data", {
			enumerable: true,
			configurable: true,
			get: () => {
				if (value !== undefined) return value;
				const data = readStoredData(stored);
				if (data === undefined) return placeholderData(stored.mimeType);
				value = data;
				return data;
			},
			set: (next: unknown) => {
				delete block[STORED];
				Object.defineProperty(block, "data", { value: next, writable: true, enumerable: true, configurable: true });
			},
		});
		Object.defineProperty(block, STORED, { value: stored, enumerable: false, configurable: true, writable: true });
		return true;
	} catch {
		// A frozen block keeps its plain data; it is simply hashed again whenever it is written.
		return false;
	}
}

function parseRef(value: unknown): SessionImageFileRef | undefined {
	if (!isRecord(value)) return undefined;
	const { sha256, mimeType, bytes } = value;
	if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
	if (typeof mimeType !== "string" || !mimeType) return undefined;
	if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return undefined;
	return { v: 1, sha256, mimeType, bytes };
}

function walk(value: unknown, visit: (block: ImageBlock) => void, depth = 0): void {
	if (depth > MAX_WALK_DEPTH || !isRecord(value)) return;
	if (Array.isArray(value)) {
		for (const item of value) if (isRecord(item)) walk(item, visit, depth + 1);
		return;
	}
	if (isImageBlock(value)) {
		visit(value);
		return;
	}
	for (const key of Object.keys(value)) {
		const child = value[key];
		if (isRecord(child)) walk(child, visit, depth + 1);
	}
}

/** Cheap pre-check on a raw JSONL line before walking its parsed value. */
export function lineReferencesImageFiles(line: string): boolean {
	return line.includes(REF_MARKER);
}

/**
 * Turn the `sessionImageFile` references of a freshly parsed entry back into image blocks with lazy data. Mutates and
 * returns the entry; nothing is read from disk here.
 */
export function restoreSessionImages<T>(sessionFile: string, entry: T): T {
	const directory = sessionImageDirFor(sessionFile);
	walk(entry, (block) => {
		const ref = parseRef(block[REF_KEY]);
		if (!ref) return;
		const stored: StoredSessionImage = {
			file: join(directory, fileName(ref.sha256, ref.mimeType)),
			sha256: ref.sha256,
			mimeType: ref.mimeType,
			bytes: ref.bytes,
		};
		delete block[REF_KEY];
		block.mimeType = ref.mimeType;
		attachStoredImage(block, stored);
	});
	return entry;
}

function plainData(block: ImageBlock): string | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(block, "data");
	return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}

/** A plain inline image large enough to be stored as a file. */
function isInlineCandidate(block: ImageBlock): boolean {
	if (storedSessionImage(block)) return false;
	const data = plainData(block);
	return data !== undefined && data.length >= SESSION_IMAGE_FILE_MIN_BASE64;
}

function hasFileOfSize(file: string, bytes: number): boolean {
	try {
		return statSync(file).size === bytes;
	} catch {
		return false;
	}
}

/** Decode canonical base64 only: anything else (line breaks, odd padding) stays inline so it round-trips exactly. */
function decodeCanonical(data: string): Buffer | undefined {
	const bytes = Buffer.from(data, "base64");
	return bytes.toString("base64") === data ? bytes : undefined;
}

function storeInlineSync(block: ImageBlock, directory: string): StoredSessionImage | undefined {
	const data = plainData(block);
	if (data === undefined) return undefined;
	const bytes = decodeCanonical(data);
	if (!bytes) return undefined;
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const stored: StoredSessionImage = {
		file: join(directory, fileName(sha256, block.mimeType)),
		sha256,
		mimeType: block.mimeType,
		bytes: bytes.length,
	};
	if (!hasFileOfSize(stored.file, bytes.length)) {
		mkdirSync(directory, { recursive: true });
		writeFileAtomicallySync(stored.file, bytes);
	}
	attachStoredImage(block, stored, data);
	return stored;
}

/** A stored image written into another Session's folder (relocation, fork, import) gets its own copy there. */
function ensureInDirectory(block: ImageBlock, stored: StoredSessionImage, directory: string): StoredSessionImage {
	if (sameDirectory(dirname(stored.file), directory)) return stored;
	const target = join(directory, basename(stored.file));
	if (hasFileOfSize(target, stored.bytes)) return { ...stored, file: target };
	mkdirSync(directory, { recursive: true });
	if (hasFileOfSize(stored.file, stored.bytes)) {
		// Copy beside the target and rename, so a crash never leaves a torn file under the final name.
		const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
		try {
			copyFileSync(stored.file, temporary);
			renameSync(temporary, target);
		} catch {
			try {
				unlinkSync(temporary);
			} catch {
				// Nothing was left behind.
			}
		}
	} else {
		// The source file is gone (or not synced yet); the block may still hold the bytes in memory.
		const bytes = Buffer.from(block.data as string, "base64");
		if (bytes.length === stored.bytes) writeFileAtomicallySync(target, bytes);
	}
	// Even when the copy failed the line names the image; a later write or sync can still supply the file.
	return { ...stored, file: target };
}

function diskBlock(block: ImageBlock, stored: StoredSessionImage): Record<string, unknown> {
	// Same key order as the block, so a loaded entry serializes exactly like the one that was written.
	const record: Record<string, unknown> = {};
	for (const key of Object.keys(block)) {
		if (key === "data") record.data = PLACEHOLDERS["image/png"];
		else if (key === "mimeType") record.mimeType = "image/png";
		else record[key] = block[key];
	}
	const ref: SessionImageFileRef = { v: 1, sha256: stored.sha256, mimeType: stored.mimeType, bytes: stored.bytes };
	record[REF_KEY] = ref;
	return record;
}

function needsImageFiles(entry: unknown): boolean {
	let found = false;
	walk(entry, (block) => {
		if (!found && (storedSessionImage(block) || isInlineCandidate(block))) found = true;
	});
	return found;
}

/**
 * JSON for one Session line. Large images of a structured Session are written as files first (durably, before the
 * line that names them) and the line carries only their reference; everything else is `JSON.stringify(entry)`.
 * The entry itself keeps its data; its image blocks gain the hidden file record.
 */
export function serializeSessionEntry(sessionFile: string, entry: unknown): string {
	const directory = writableImageDir(sessionFile);
	if (!directory || !needsImageFiles(entry)) return JSON.stringify(entry);
	return JSON.stringify(entry, (_key, value: unknown) => {
		if (!isImageBlock(value)) return value;
		const known = storedSessionImage(value);
		const stored = known
			? ensureInDirectory(value, known, directory)
			: isInlineCandidate(value)
				? storeInlineSync(value, directory)
				: undefined;
		return stored ? diskBlock(value, stored) : value;
	});
}

/**
 * Write the files for every inline large image of these entries with async I/O, ahead of a rewrite that then only
 * names them. Returns how many blocks now carry a file record. Used to move an older chat's images out of its JSONL
 * without blocking the server for the whole hashing and writing.
 */
export async function prepareInlineImageFiles(
	sessionFile: string,
	entries: readonly unknown[],
	shouldContinue: () => boolean = () => true,
): Promise<number> {
	const directory = writableImageDir(sessionFile);
	if (!directory) return 0;
	const blocks: ImageBlock[] = [];
	for (const entry of entries)
		walk(entry, (block) => {
			if (isInlineCandidate(block)) blocks.push(block);
		});
	let prepared = 0;
	for (const block of blocks) {
		if (!shouldContinue()) break;
		const data = plainData(block);
		if (data === undefined) continue;
		const bytes = decodeCanonical(data);
		if (!bytes) continue;
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const stored: StoredSessionImage = {
			file: join(directory, fileName(sha256, block.mimeType)),
			sha256,
			mimeType: block.mimeType,
			bytes: bytes.length,
		};
		let present = false;
		try {
			present = (await stat(stored.file)).size === bytes.length;
		} catch {
			present = false;
		}
		if (!present) {
			await mkdir(directory, { recursive: true });
			await writeFileAtomically(stored.file, bytes);
		}
		// The data may have been replaced while the file was written; only an unchanged block refers to it.
		if (plainData(block) === data && attachStoredImage(block, stored, data)) prepared++;
		// Let other requests run between images.
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return prepared;
}

/** Whether any of these entries still keeps a large image inline that its Session could store as a file. */
export function hasInlineImagesToStore(sessionFile: string, entries: readonly unknown[]): boolean {
	if (!writableImageDir(sessionFile)) return false;
	for (const entry of entries) {
		let found = false;
		walk(entry, (block) => {
			if (!found && isInlineCandidate(block)) found = true;
		});
		if (found) return true;
	}
	return false;
}

/**
 * After a Session file was moved into another Session folder (writing it there copied its images along), remove the
 * old folder's image files once no Session file is left beside them. A file is only removed when the target holds a
 * copy of the same name and size, so an image whose copy failed is never lost.
 */
export function removeMovedSessionImages(sourceFile: string, targetFile: string): void {
	const sourceDir = sessionImageDirFor(sourceFile);
	const targetDir = sessionImageDirFor(targetFile);
	if (sameDirectory(sourceDir, targetDir)) return;
	try {
		if (readdirSync(dirname(sourceFile)).some((name) => name.endsWith(".jsonl"))) return;
		const folder = lstatSync(sourceDir);
		if (folder.isSymbolicLink() || !folder.isDirectory()) return;
		for (const name of readdirSync(sourceDir)) {
			const file = join(sourceDir, name);
			const stats = lstatSync(file);
			if (stats.isFile() && hasFileOfSize(join(targetDir, name), stats.size)) unlinkSync(file);
		}
		rmdirSync(sourceDir);
	} catch {
		// Leftover images only cost disk space; the moved chat already has its own copies.
	}
}
