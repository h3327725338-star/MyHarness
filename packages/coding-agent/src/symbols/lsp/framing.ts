/**
 * LSP over stdio framing（板块 3）。
 *
 * 协议格式：
 *   Content-Length: <N>\r\n
 *   [其他 header]\r\n
 *   \r\n
 *   <N 字节 UTF-8 JSON body>
 *
 * 关键约束：
 * - Content-Length 是 UTF-8 字节长度，不是 JavaScript string.length。
 * - stdout 的 data 事件不保证一个 chunk 等于一个消息，必须支持
 *   header 拆分 / body 拆分 / 一个 chunk 多个消息 / 半条消息跨 chunk。
 * - 在收够 body 字节之前只操作 Buffer，不提前转 string，避免 Unicode
 *   byte boundary 问题。
 * - 必须限制消息大小（maxMessageBytes）与 header 大小（maxHeaderBytes），
 *   防止恶意 server 导致无限缓冲。
 */

import { LspProtocolError } from "./errors.ts";
import type { JsonValue } from "./types.ts";

export interface ParsedLspMessage {
	/** 原始 JSON 文本（调试用，不含 header） */
	raw: string;
	/** 解析后的 JSON 值 */
	value: JsonValue;
}

type ProtocolErrorWithParsedMessages = LspProtocolError & {
	parsedMessages?: ParsedLspMessage[];
};

function rethrowWithParsedMessages(error: unknown, messages: ParsedLspMessage[]): never {
	if (messages.length > 0 && error instanceof LspProtocolError) {
		(error as ProtocolErrorWithParsedMessages).parsedMessages = messages;
	}
	throw error;
}

const CRLF = "\r\n";
const CRLFCRLF = "\r\n\r\n";

/**
 * 增量 framing parser。
 *
 * 用法：stdout 'data' 事件里调用 push(chunk)，返回本次 chunk 中解析出的
 * 全部完整消息；剩余字节缓存在内部 buffer 等待后续 chunk。
 * 遇 malformed frame 抛 LspProtocolError（调用方应标记连接不可用）。
 */
export class LspFrameParser {
	private buffer: Buffer = Buffer.alloc(0);
	private readonly maxMessageBytes: number;
	private readonly maxHeaderBytes: number;

	constructor(options: { maxMessageBytes?: number; maxHeaderBytes?: number } = {}) {
		this.maxMessageBytes = options.maxMessageBytes ?? 32 * 1024 * 1024;
		this.maxHeaderBytes = options.maxHeaderBytes ?? 64 * 1024;
	}

	/** 当前未消费的缓冲字节数（诊断用）。 */
	get bufferedBytes(): number {
		return this.buffer.length;
	}

	/**
	 * 注入一个 stdout chunk，返回解析出的完整消息。
	 * 抛 LspProtocolError：header 超限 / 缺 Content-Length / 非法 Content-Length /
	 * 消息超限 / 损坏 JSON。
	 */
	push(chunk: Buffer): ParsedLspMessage[] {
		if (chunk.length > 0) {
			this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		}

		const messages: ParsedLspMessage[] = [];
		for (;;) {
			const headerEnd = this.buffer.indexOf(CRLFCRLF);
			if (headerEnd === -1) {
				// 还没有完整的 header 终止符：防止无终止符的巨大 header 无限缓冲
				if (this.buffer.length > this.maxHeaderBytes) {
					throw new LspProtocolError(
						`LSP header exceeds maxHeaderBytes (${this.maxHeaderBytes}) without terminator`,
					);
				}
				break;
			}

			const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
			let contentLength: number;
			try {
				contentLength = parseContentLength(headerText, this.maxHeaderBytes);
			} catch (error) {
				rethrowWithParsedMessages(error, messages);
			}
			if (contentLength > this.maxMessageBytes) {
				rethrowWithParsedMessages(
					new LspProtocolError(
						`LSP message body length ${contentLength} exceeds maxMessageBytes (${this.maxMessageBytes})`,
					),
					messages,
				);
			}

			const bodyStart = headerEnd + CRLFCRLF.length;
			const totalLength = bodyStart + contentLength;
			if (this.buffer.length < totalLength) {
				// body 未收够：等待后续 chunk
				break;
			}

			const raw = this.buffer.subarray(bodyStart, totalLength).toString("utf8");
			let value: JsonValue;
			try {
				value = JSON.parse(raw) as JsonValue;
			} catch (cause) {
				rethrowWithParsedMessages(
					new LspProtocolError(`invalid JSON in LSP message body: ${(cause as Error).message}`, { cause }),
					messages,
				);
			}
			messages.push({ raw, value });
			this.buffer = this.buffer.subarray(totalLength);
		}
		return messages;
	}

	/**
	 * 连接结束时调用：返回是否有未完成（残缺）的 frame。
	 * 进程退出后残留的不完整消息无法继续解析，调用方通常只需记录。
	 */
	hasPendingData(): boolean {
		return this.buffer.length > 0;
	}

	/** 清空缓冲（dispose 时调用）。 */
	clear(): void {
		this.buffer = Buffer.alloc(0);
	}
}

/**
 * 解析 header 区，返回 Content-Length。
 * - header 名大小写不敏感（LSP 规范为 "Content-Length"，但容错）。
 * - 未知 header（如 Content-Type）忽略。
 * - 缺 Content-Length / 非数字 / 负数 → LspProtocolError。
 */
export function parseContentLength(headerText: string, maxHeaderBytes: number): number {
	if (headerText.length > maxHeaderBytes) {
		throw new LspProtocolError(`LSP header exceeds maxHeaderBytes (${maxHeaderBytes})`);
	}

	let contentLength: number | undefined;
	for (const line of headerText.split(CRLF)) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		if (name !== "content-length") continue;
		const rawValue = line.slice(colon + 1).trim();
		if (!/^\d+$/.test(rawValue)) {
			throw new LspProtocolError(`invalid Content-Length: ${JSON.stringify(rawValue)}`);
		}
		const parsed = Number(rawValue);
		if (!Number.isSafeInteger(parsed)) {
			throw new LspProtocolError(`Content-Length out of range: ${rawValue}`);
		}
		contentLength = parsed;
	}
	if (contentLength === undefined) {
		throw new LspProtocolError("missing Content-Length header");
	}
	return contentLength;
}

/**
 * 把 JSON-RPC 消息编码为带 Content-Length 的帧。
 * Content-Length 使用 UTF-8 字节长度（Buffer.byteLength），不是 string.length。
 */
export function encodeLspMessage(payload: JsonValue): Buffer {
	const json = JSON.stringify(payload);
	const body = Buffer.from(json, "utf8");
	const header = Buffer.from(`Content-Length: ${body.length}${CRLF}${CRLF}`, "ascii");
	return Buffer.concat([header, body]);
}
