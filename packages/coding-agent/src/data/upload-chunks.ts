import { closeSync, fstatSync, openSync, writeSync } from "node:fs";

/** Largest single file the Web UI accepts, for workspace sources and chat attachments alike. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Largest decoded chunk one request may carry; keeps each JSON body far below the HTTP body limit. */
export const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** Decode one base64 chunk, refusing malformed or oversized data before anything touches the disk. */
export function decodeUploadChunk(data: string): Buffer {
	if (data.length > Math.ceil(MAX_UPLOAD_CHUNK_BYTES / 3) * 4) throw new Error("Upload chunk is too large.");
	if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Invalid base64 file data.");
	return Buffer.from(data, "base64");
}

/**
 * Write one chunk of a file that is uploaded in order. Offset 0 (re)starts the file, so a retried file simply begins
 * again; any other offset must equal the bytes already written, so a lost or repeated chunk can never leave a hole or
 * a duplicate. Returns the file's size after the write.
 */
export function writeUploadChunk(file: string, offset: number, bytes: Buffer, total: number): number {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset + bytes.length > total)
		throw new Error("The chunk does not fit the declared file size.");
	const fd = openSync(file, offset === 0 ? "w" : "r+");
	try {
		if (fstatSync(fd).size !== offset) throw new Error("The chunk is out of order; restart this file.");
		let written = 0;
		while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, offset + written);
		return offset + bytes.length;
	} finally {
		closeSync(fd);
	}
}
