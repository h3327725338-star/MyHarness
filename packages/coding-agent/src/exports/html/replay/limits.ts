/**
 * Export size limit for standalone HTML replay.
 *
 * The replay always embeds the complete raw session JSONL and never silently
 * truncates it. Sessions larger than the limit fail loudly so the caller can
 * surface a clear error (the Web export route answers HTTP 413).
 */

export const EXPORT_MAX_JSONL_BYTES = 30 * 1024 * 1024;

export class ReplayExportTooLargeError extends Error {
	readonly bytes: number;
	readonly limit: number;
	constructor(bytes: number, limit: number) {
		super(`Session export too large: ${formatMib(bytes)} MiB exceeds the ${formatMib(limit)} MiB limit.`);
		this.name = "ReplayExportTooLargeError";
		this.bytes = bytes;
		this.limit = limit;
	}
}

export function formatMib(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

export function buildExportTooLargeBody(error: ReplayExportTooLargeError): {
	error: string;
	code: "export_too_large";
	bytes: number;
	limit: number;
} {
	return {
		error:
			`This conversation is too large to export as a single HTML file ` +
			`(${formatMib(error.bytes)} MiB of session data, limit ${formatMib(error.limit)} MiB). ` +
			`Start a new chat and export that one, or copy the conversation's .jsonl file from the data folder.`,
		code: "export_too_large",
		bytes: error.bytes,
		limit: error.limit,
	};
}
