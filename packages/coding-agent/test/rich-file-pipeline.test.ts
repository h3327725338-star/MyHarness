import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OfficeContentNode } from "officeparser";
import { describe, expect, it } from "vitest";
import {
	extractionCacheRoots,
	extractionKey,
	readExtractionCache,
	writeExtractionCache,
} from "../src/tools/files/extraction-cache.ts";
import { extractPptStream } from "../src/tools/files/legacy-office.ts";
import { createReadTool } from "../src/tools/files/read.ts";
import { formatSpreadsheet } from "../src/tools/files/spreadsheet-preview.ts";
import { preprocessLocalFile } from "../src/utils/file-preprocess.ts";

const root = process.env.MYHARNESS_TEMP_DIR ?? join(process.cwd(), "../../data/cache/test-artifacts");
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, "rich-pipeline-"));
function record(type: number, body: Buffer, container = false): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt16LE(container ? 15 : 0);
	header.writeUInt16LE(type, 2);
	header.writeUInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
}

describe("rich file pipeline", () => {
	it("preserves small code files including BOM, CRLF, indentation and final newline", async () => {
		const path = join(directory, "exact.ts");
		const text = "\uFEFF  const x = 1;\r\n\t// comment\r\n";
		writeFileSync(path, text);
		const result = await createReadTool(directory).execute("exact", { path });
		expect(result.content[0]).toEqual({ type: "text", text });
	});
	it("extracts numbered legacy PPT text records and rejects damaged lengths", () => {
		const slides = ["标题一\r正文一", "标题二\r正文二"].map((text) =>
			record(1006, record(4000, Buffer.from(text, "utf16le")), true),
		);
		const text = extractPptStream(Buffer.concat(slides));
		expect(text).toContain("第 1 张幻灯片");
		expect(text).toContain("第 2 张幻灯片");
		expect(text).toContain("正文二");
		const damaged = record(4000, Buffer.from("x"));
		damaged.writeUInt32LE(9999, 4);
		expect(() => extractPptStream(damaged)).toThrow("损坏");
	});

	it("reads a complete synthetic CFB PPT through the tool", async () => {
		const payload = record(1006, record(4000, Buffer.from("Legacy slide body", "utf16le")), true);
		const bytes = Buffer.alloc(512 * 11);
		Buffer.from("d0cf11e0a1b11ae1", "hex").copy(bytes);
		bytes.writeUInt16LE(3, 26);
		bytes.writeUInt16LE(9, 30);
		bytes.writeUInt16LE(6, 32);
		bytes.writeUInt32LE(1, 44);
		bytes.writeUInt32LE(1, 48);
		bytes.writeUInt32LE(4096, 56);
		bytes.writeUInt32LE(0xfffffffe, 60);
		bytes.writeUInt32LE(0xfffffffe, 68);
		bytes.fill(0xff, 76, 512);
		bytes.writeUInt32LE(0, 76);
		bytes.fill(0xff, 512, 1024);
		bytes.writeUInt32LE(0xfffffffd, 512);
		bytes.writeUInt32LE(0xfffffffe, 516);
		for (let id = 2; id <= 9; id++) bytes.writeUInt32LE(id === 9 ? 0xfffffffe : id + 1, 512 + id * 4);
		const entry = (off: number, name: string, type: number, start: number, size: number) => {
			Buffer.from(`${name}\0`, "utf16le").copy(bytes, off);
			bytes.writeUInt16LE((name.length + 1) * 2, off + 64);
			bytes[off + 66] = type;
			bytes.writeUInt32LE(start, off + 116);
			bytes.writeUInt32LE(size, off + 120);
		};
		entry(1024, "Root Entry", 5, 0xfffffffe, 0);
		entry(1152, "PowerPoint Document", 2, 2, 4096);
		payload.copy(bytes, 1536);
		const path = join(directory, "complete.ppt");
		writeFileSync(path, bytes);
		const result = await createReadTool(directory).execute("legacy", { path });
		expect(JSON.stringify(result.content)).toContain("Legacy slide body");
	});

	it("uses bounded Markdown tables and sheet overview", () => {
		const rows = Array.from({ length: 120 }, (_, row) => ({
			type: "row",
			children: Array.from({ length: 35 }, (_, col) => ({
				type: "cell",
				text: `${row}|${col}`,
				metadata: { row, col },
			})),
		}));
		const text = formatSpreadsheet([
			{ type: "sheet", metadata: { sheetName: "数据" }, children: rows },
		] as OfficeContentNode[]);
		expect(text).toContain("总行数：120；总列数：35");
		expect(text).toContain("工作表概览");
		expect(text).toContain("| --- |");
		expect(text).toContain("已截断");
		expect(text).not.toContain("119\\|34");
	});

	it("parses CSV quoted delimiters and RTF rather than returning source markup", async () => {
		const csv = join(directory, "quoted.csv");
		writeFileSync(csv, 'Name,Note\nAlice,"hello, world"\n');
		const result = await preprocessLocalFile(csv);
		expect(result?.text).toContain("hello, world");
		expect(result?.text).toContain("| Name | Note |");
		const rtf = join(directory, "body.rtf");
		writeFileSync(rtf, "{\\rtf1\\ansi Hello \\b world\\b0\\par}");
		expect((await preprocessLocalFile(rtf))?.text).toContain("Hello");
	});

	it("reuses scoped disk cache and invalidates on metadata change", async () => {
		const scope = {
			dataRoot: join(directory, "data"),
			workspaceId: "workspace",
			sessionId: "chat",
			conversationDir: "unused",
		};
		const roots = extractionCacheRoots(scope);
		const source = join(directory, "source.ppt");
		const key = extractionKey(source, 40, 100, "images");
		await writeExtractionCache(roots[1]!, key, source, 40, 100, {
			kind: "document",
			text: "cached body",
			images: [],
		});
		expect((await readExtractionCache(roots, key))?.text).toBe("cached body");
		expect(await readExtractionCache(roots, extractionKey(source, 40, 101, "images"))).toBeUndefined();
		expect(readFileSync(join(roots[1]!, key, "extracted.md"), "utf8")).toBe("cached body");
		await writeExtractionCache(roots[0]!, key, source, 40, 100, {
			kind: "document",
			text: "session override",
			images: [],
		});
		expect((await readExtractionCache(roots, key))?.text).toBe("session override");
	});

	it("returns successful diagnostics for corrupt rich files in the shared read tool", async () => {
		const path = join(directory, "broken.ppt");
		writeFileSync(path, "broken");
		const result = await createReadTool(directory).execute("corrupt", { path });
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(JSON.stringify(result.content)).toContain("预处理失败");
	});
});
