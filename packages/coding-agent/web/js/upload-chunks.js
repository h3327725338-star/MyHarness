// Chunked file uploads shared by the sources page and the composer: a file is read and sent one slice at a time, so
// even a 500 MiB file never sits in memory whole (as bytes or as base64).
import { t } from "./i18n.js";

/** Largest file either upload accepts (the server checks the same limit). */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Bytes per request; the server takes at most 8 MiB, this leaves room. */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** One slice of a file as base64 (without the data-URL prefix). */
export const blobBase64 = (blob) => new Promise((resolve, reject) => {
	const reader = new FileReader();
	reader.onload = () => {
		const result = String(reader.result);
		resolve(result.slice(result.indexOf(",") + 1));
	};
	reader.onerror = () => reject(reader.error ?? new Error(t("Could not read the file.")));
	reader.readAsDataURL(blob);
});

/** Whether the browser can still read the file (it may have been moved, locked or deleted since it was picked). */
export async function canReadFile(file) {
	try {
		await file.slice(0, Math.min(1, file.size)).arrayBuffer();
		return true;
	} catch {
		return false;
	}
}

/**
 * Send `file` in order through `send(offset, base64)`, which posts one chunk. An empty file is one empty chunk.
 * `shouldStop()` lets a stopped batch end between chunks instead of finishing a large file first.
 */
export async function sendFileInChunks(file, send, shouldStop = () => false) {
	let offset = 0;
	do {
		if (shouldStop()) throw new Error(t("Upload stopped."));
		const end = Math.min(file.size, offset + CHUNK_BYTES);
		let data;
		try {
			data = await blobBase64(file.slice(offset, end));
		} catch {
			throw new Error(t("Could not read the file."));
		}
		await send(offset, data);
		offset = end;
	} while (offset < file.size);
}
