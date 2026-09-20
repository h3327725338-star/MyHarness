import { randomBytes } from "node:crypto";
import { createWriteStream, openSync, type WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateHead, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
	/** Which part of the rolling decoded preview to retain. */
	mode?: "head" | "tail";
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private static readonly MAX_APPEND_CHUNK_BYTES = 64 * 1024;

	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly mode: "head" | "tail";
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private headText = "";
	private headBytes = 0;
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;
	private tempFileError: Error | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "myharness-output";
		this.mode = options.mode ?? "tail";
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		for (let offset = 0; offset < data.length; offset += OutputAccumulator.MAX_APPEND_CHUNK_BYTES) {
			this.appendChunk(data.subarray(offset, offset + OutputAccumulator.MAX_APPEND_CHUNK_BYTES));
		}
	}

	private appendChunk(data: Buffer): void {
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			if (this.tempFileStream && !this.tempFileError) {
				this.tempFileStream.write(data);
			}
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const rollingTruncation =
			this.mode === "head"
				? truncateHead(this.getSnapshotText(), {
						maxLines: this.maxLines,
						maxBytes: this.maxBytes,
					})
				: truncateTail(this.getSnapshotText(), {
						maxLines: this.maxLines,
						maxBytes: this.maxBytes,
					});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (rollingTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...rollingTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			// A failed temp file must not be advertised to the model/user.
			fullOutputPath: this.tempFileError ? undefined : this.tempFilePath,
		};
	}

	async closeTempFile(): Promise<void> {
		const stream = this.tempFileStream;
		if (!stream) {
			return;
		}
		this.tempFileStream = undefined;

		// The temp file is best-effort: a write failure must never reject (and thus
		// fail an otherwise successful command) nor wait forever for a `finish`
		// event that cannot arrive on an errored stream.
		if (this.tempFileError) {
			stream.destroy();
			if (this.tempFilePath) {
				await rm(this.tempFilePath, { force: true }).catch(() => {});
				this.tempFilePath = undefined;
			}
			return;
		}

		await new Promise<void>((resolve) => {
			const done = () => {
				stream.off("finish", done);
				stream.off("error", done);
				stream.destroy();
				resolve();
			};
			stream.once("finish", done);
			stream.once("error", done);
			try {
				stream.end();
			} catch {
				done();
			}
		});
	}

	/** Close and remove an intermediate output file when the owning operation fails. */
	async discardTempFile(): Promise<void> {
		const stream = this.tempFileStream;
		this.tempFileStream = undefined;
		stream?.destroy();
		if (this.tempFilePath) {
			await rm(this.tempFilePath, { force: true }).catch(() => {});
			this.tempFilePath = undefined;
		}
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		if (this.mode === "head") {
			this.appendHead(text);
		} else {
			this.tailText += text;
			this.tailBytes += bytes;
			if (this.tailBytes > this.maxRollingBytes * 2) {
				this.trimTail();
			}
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private appendHead(text: string): void {
		if (this.headBytes >= this.maxRollingBytes) {
			return;
		}
		let remaining = this.maxRollingBytes - this.headBytes;
		let prefix = "";
		for (const character of text) {
			const bytes = byteLength(character);
			if (bytes > remaining) {
				break;
			}
			prefix += character;
			remaining -= bytes;
		}
		this.headText += prefix;
		this.headBytes += byteLength(prefix);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.mode === "head") {
			return this.headText;
		}
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath || this.tempFileError) {
			return;
		}
		const tempFilePath = defaultTempFilePath(this.tempFilePrefix);
		let stream: WriteStream;
		try {
			// Open synchronously so an unusable temp directory is detected before the
			// snapshot advertises a path that can never exist.
			const fd = openSync(tempFilePath, "w", 0o600);
			stream = createWriteStream(tempFilePath, { fd });
		} catch (error) {
			this.tempFileError = error instanceof Error ? error : new Error(String(error));
			this.rawChunks = [];
			return;
		}
		// A write error must never surface as an unhandled stream error (which would
		// crash the process); record it and stop using the temp file.
		stream.on("error", (error: Error) => {
			this.tempFileError ??= error;
		});
		this.tempFilePath = tempFilePath;
		this.tempFileStream = stream;
		for (const chunk of this.rawChunks) {
			stream.write(chunk);
		}
		this.rawChunks = [];
	}
}
