/**
 * Framing 单元测试（板块 3）。
 *
 * 覆盖：Content-Length framing、chunk fragmentation（header/body 拆分、
 * 多消息一帧、半条消息跨 chunk）、UTF-8 字节长度、malformed header、
 * 消息大小限制、损坏 JSON。
 */

import { describe, expect, it } from "vitest";

import { LspProtocolError } from "../../../src/symbols/lsp/errors.ts";
import { encodeLspMessage, LspFrameParser, parseContentLength } from "../../../src/symbols/lsp/framing.ts";
import type { JsonValue } from "../../../src/symbols/lsp/types.ts";

/** 构造标准帧：Content-Length 按 UTF-8 byte length 计算 */
function frame(payload: unknown): Buffer {
	return encodeLspMessage(payload as JsonValue);
}

function parseAll(frames: Buffer[], options?: { maxMessageBytes?: number; maxHeaderBytes?: number }): JsonValue[] {
	const parser = new LspFrameParser(options);
	const values: JsonValue[] = [];
	for (const chunk of frames) {
		values.push(...parser.push(chunk).map((m) => m.value));
	}
	return values;
}

describe("LspFrameParser: 基本解析", () => {
	it("header 与 body 一次到达时解析出消息", () => {
		const chunk = frame({ jsonrpc: "2.0", id: 1, method: "x", params: { a: 1 } });
		const values = parseAll([chunk]);
		expect(values).toHaveLength(1);
		expect(values[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "x" });
	});

	it("解析后 parser 内部缓冲为空", () => {
		const parser = new LspFrameParser();
		parser.push(frame({ a: 1 }));
		expect(parser.bufferedBytes).toBe(0);
	});

	it("空 chunk 不产生消息", () => {
		const parser = new LspFrameParser();
		expect(parser.push(Buffer.alloc(0))).toEqual([]);
	});
});

describe("LspFrameParser: chunk fragmentation", () => {
	it("header 被拆成两个 chunk", () => {
		const payload = { jsonrpc: "2.0", id: 1, method: "x" };
		const full = frame(payload);
		// 把 header 在 "Content-Len" 与 "gth:" 之间切开
		const splitAt = "Content-Len".length;
		const values = parseAll([full.subarray(0, splitAt), full.subarray(splitAt)]);
		expect(values).toEqual([payload]);
	});

	it("body 被拆成多个 chunk", () => {
		const payload = { jsonrpc: "2.0", id: 2, method: "y", params: { list: [1, 2, 3, 4, 5] } };
		const full = frame(payload);
		const headerEnd = full.indexOf("\r\n\r\n") + 4;
		const chunks = [
			full.subarray(0, headerEnd + 3),
			full.subarray(headerEnd + 3, headerEnd + 7),
			full.subarray(headerEnd + 7),
		];
		const values = parseAll(chunks);
		expect(values).toEqual([payload]);
	});

	it("一个 chunk 包含多个完整消息", () => {
		const a = frame({ jsonrpc: "2.0", id: 1, method: "a" });
		const b = frame({ jsonrpc: "2.0", id: 2, method: "b" });
		const c = frame({ jsonrpc: "2.0", id: 3, method: "c" });
		const values = parseAll([Buffer.concat([a, b, c])]);
		expect(values.map((v) => (v as { id: number }).id)).toEqual([1, 2, 3]);
	});

	it("第一条完整 + 第二条半条，剩余字节由下个 chunk 补齐", () => {
		const a = frame({ jsonrpc: "2.0", id: 1, method: "a" });
		const b = frame({ jsonrpc: "2.0", id: 2, method: "b" });
		const headerEndB = b.indexOf("\r\n\r\n") + 4;
		const halfB = b.subarray(0, headerEndB + 2);

		const parser = new LspFrameParser();
		const first = parser.push(Buffer.concat([a, halfB]));
		expect(first).toHaveLength(1);
		expect((first[0].value as { id: number }).id).toBe(1);
		expect(parser.bufferedBytes).toBe(halfB.length);

		const rest = parser.push(b.subarray(headerEndB + 2));
		expect(rest).toHaveLength(1);
		expect((rest[0].value as { id: number }).id).toBe(2);
		expect(parser.bufferedBytes).toBe(0);
	});

	it("字节级拆分（逐字节 push）也能正确解析", () => {
		const payload = { jsonrpc: "2.0", id: 7, method: "bytewise" };
		const full = frame(payload);
		const parser = new LspFrameParser();
		const values: JsonValue[] = [];
		for (const byte of full) {
			const parsed = parser.push(Buffer.from([byte]));
			values.push(...parsed.map((m) => m.value));
		}
		expect(values).toEqual([payload]);
	});
});

describe("LspFrameParser: UTF-8 Content-Length", () => {
	it("中文与 emoji 按 UTF-8 字节长度消费", () => {
		const payload = { jsonrpc: "2.0", id: 1, method: "echo", params: { text: "用户你好", emoji: "🚀🎉" } };
		const values = parseAll([frame(payload)]);
		expect(values).toEqual([payload]);
	});

	it("Content-Length 是字节长度而不是 string.length（用 string.length 会导致帧损坏）", () => {
		const payload = { jsonrpc: "2.0", id: 1, method: "echo", params: { text: "用户" } };
		const json = JSON.stringify(payload);
		const byteLength = Buffer.byteLength(json, "utf8");
		const stringLength = json.length;
		// "用户" 的 UTF-8 编码是 6 字节，string.length 只有 2
		expect(byteLength).toBeGreaterThan(stringLength);

		const wrongBody = Buffer.from(json, "utf8");
		const wrongFrame = Buffer.concat([Buffer.from(`Content-Length: ${stringLength}\r\n\r\n`, "ascii"), wrongBody]);
		const parser = new LspFrameParser();
		// 按声明长度截取的 body 是损坏 JSON → 必须报协议错误，而不是静默等待或解析出错误内容
		expect(() => parser.push(wrongFrame)).toThrow(LspProtocolError);
		expect(() => parser.push(wrongFrame)).toThrow(/invalid JSON/i);
	});

	it("encodeLspMessage 的 Content-Length 等于 UTF-8 字节数", () => {
		const payload = { text: "中文🚀" };
		const encoded = frame(payload);
		const headerText = encoded.subarray(0, encoded.indexOf("\r\n\r\n")).toString("utf8");
		const match = /Content-Length: (\d+)/i.exec(headerText);
		expect(match).not.toBeNull();
		expect(Number(match?.[1])).toBe(Buffer.byteLength(JSON.stringify(payload), "utf8"));
	});
});

describe("LspFrameParser: header 解析", () => {
	it("header 名大小写不敏感", () => {
		const body = Buffer.from('{"a":1}', "utf8");
		const chunk = Buffer.concat([Buffer.from(`content-length: ${body.length}\r\n\r\n`, "ascii"), body]);
		expect(parseAll([chunk])).toEqual([{ a: 1 }]);
	});

	it("未知 header（Content-Type 等）被忽略", () => {
		const body = Buffer.from('{"a":1}', "utf8");
		const chunk = Buffer.concat([
			Buffer.from(
				`Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`,
				"ascii",
			),
			body,
		]);
		expect(parseAll([chunk])).toEqual([{ a: 1 }]);
	});

	it("Content-Length 前后的空白被容忍", () => {
		const body = Buffer.from('{"a":1}', "utf8");
		const chunk = Buffer.concat([Buffer.from(`Content-Length:  ${body.length}  \r\n\r\n`, "ascii"), body]);
		expect(parseAll([chunk])).toEqual([{ a: 1 }]);
	});
});

describe("LspFrameParser: malformed frame", () => {
	it("缺 Content-Length 抛 LspProtocolError", () => {
		const parser = new LspFrameParser();
		const chunk = Buffer.from('X-Foo: bar\r\n\r\n{"a":1}', "ascii");
		expect(() => parser.push(chunk)).toThrow(LspProtocolError);
		expect(() => parser.push(chunk)).toThrow(/missing Content-Length/i);
	});

	it("非法 Content-Length（abc）抛 LspProtocolError", () => {
		const parser = new LspFrameParser();
		const chunk = Buffer.from('Content-Length: abc\r\n\r\n{"a":1}', "ascii");
		expect(() => parser.push(chunk)).toThrow(LspProtocolError);
		expect(() => parser.push(chunk)).toThrow(/invalid Content-Length/i);
	});

	it("负 Content-Length 抛 LspProtocolError", () => {
		const parser = new LspFrameParser();
		const chunk = Buffer.from('Content-Length: -1\r\n\r\n{"a":1}', "ascii");
		expect(() => parser.push(chunk)).toThrow(LspProtocolError);
	});

	it("超长数字 Content-Length（溢出）抛 LspProtocolError", () => {
		const parser = new LspFrameParser();
		const chunk = Buffer.from("Content-Length: 99999999999999999999\r\n\r\n{}", "ascii");
		expect(() => parser.push(chunk)).toThrow(LspProtocolError);
	});

	it("损坏 JSON 抛 LspProtocolError", () => {
		const parser = new LspFrameParser();
		const body = Buffer.from("{not json", "utf8");
		const chunk = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
		expect(() => parser.push(chunk)).toThrow(LspProtocolError);
		expect(() => parser.push(chunk)).toThrow(/invalid JSON/i);
	});
});

describe("LspFrameParser: 大小限制", () => {
	it("body 超过 maxMessageBytes 抛 LspProtocolError，且不等待 body 到齐", () => {
		const parser = new LspFrameParser({ maxMessageBytes: 16 });
		// 只发送 header + 一小段 body：长度声明超限应立即报错，而不是等完整 body
		const chunk = Buffer.from('Content-Length: 100000\r\n\r\n{"a":1}', "ascii");
		expect(() => parser.push(chunk)).toThrow(LspProtocolError);
		expect(() => parser.push(chunk)).toThrow(/maxMessageBytes/i);
	});

	it("自定义 maxMessageBytes 生效", () => {
		const parser = new LspFrameParser({ maxMessageBytes: 100 });
		const bigPayload = { data: "x".repeat(500) };
		expect(() => parser.push(frame(bigPayload))).toThrow(LspProtocolError);
	});

	it("header 无终止符且超过 maxHeaderBytes 抛 LspProtocolError", () => {
		const parser = new LspFrameParser({ maxHeaderBytes: 32 });
		const chunk = Buffer.from(`Content-Length: 5\r\nX-Padding: ${"y".repeat(64)}`, "ascii");
		expect(() => parser.push(chunk)).toThrow(LspProtocolError);
		expect(() => parser.push(chunk)).toThrow(/maxHeaderBytes/i);
	});

	it("header 在限制内时等待更多数据不抛错", () => {
		const parser = new LspFrameParser({ maxHeaderBytes: 1024 });
		expect(parser.push(Buffer.from("Content-Len", "ascii"))).toEqual([]);
		expect(parser.bufferedBytes).toBeGreaterThan(0);
	});
});

describe("parseContentLength", () => {
	it("解析正常值", () => {
		expect(parseContentLength("Content-Length: 42", 1024)).toBe(42);
		expect(parseContentLength("content-length: 7\r\nContent-Type: x", 1024)).toBe(7);
	});

	it("没有 Content-Length 时抛错", () => {
		expect(() => parseContentLength("Content-Type: x", 1024)).toThrow(LspProtocolError);
	});

	it("多个 Content-Length 时取最后一个", () => {
		expect(parseContentLength("Content-Length: 1\r\nContent-Length: 2", 1024)).toBe(2);
	});
});
