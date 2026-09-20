import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePsdBuffer } from "ag-psd";
import { strToU8, zipSync } from "fflate";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.ts";
import { createReadTool } from "../src/tools/files/read.ts";
import { preprocessLocalFile } from "../src/utils/file-preprocess.ts";

const require = createRequire(import.meta.url);

function createMinimalPdf(text: string): Buffer {
	const stream = `BT /F1 24 Tf 50 100 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let body = "%PDF-1.4\n";
	const offsets = [0];
	for (let index = 0; index < objects.length; index++) {
		offsets.push(Buffer.byteLength(body));
		body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xrefOffset = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) {
		body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	}
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body);
}

function createMultiPagePdf(pageTexts: string[]): Buffer {
	const pageCount = pageTexts.length;
	const firstContentId = 3 + pageCount;
	const fontId = firstContentId + pageCount;
	const pageIds = pageTexts.map((_, index) => 3 + index);
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
		...pageTexts.map(
			(_, index) =>
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${firstContentId + index} 0 R >>`,
		),
		...pageTexts.map((text) => {
			const stream = `BT /F1 18 Tf 30 100 Td (${text}) Tj ET`;
			return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
		}),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let body = "%PDF-1.4\n";
	const offsets = [0];
	for (let index = 0; index < objects.length; index++) {
		offsets.push(Buffer.byteLength(body));
		body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xrefOffset = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body);
}

function createMinimalDocx(text: string): Uint8Array {
	return zipSync({
		"[Content_Types].xml": strToU8(
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		),
		"_rels/.rels": strToU8(
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
		),
		"word/document.xml": strToU8(
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
		),
	});
}

function createMinimalXlsx(text: string): Uint8Array {
	return zipSync({
		"xl/workbook.xml": strToU8(
			'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
		),
		"xl/_rels/workbook.xml.rels": strToU8(
			'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
		),
		"xl/sharedStrings.xml": strToU8(
			`<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>${text}</t></si></sst>`,
		),
		"xl/worksheets/sheet1.xml": strToU8(
			'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
		),
	});
}

function createMinimalPptx(text: string): Uint8Array {
	return zipSync({
		"[Content_Types].xml": strToU8(
			'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
		),
		"_rels/.rels": strToU8(
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
		),
		"ppt/presentation.xml": strToU8(
			'<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>',
		),
		"ppt/_rels/presentation.xml.rels": strToU8(
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
		),
		"ppt/slides/slide1.xml": strToU8(
			`<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
		),
	});
}

describe("local rich file preprocessing", () => {
	let directory: string;

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "myharness-file-preprocess-"));
	});

	afterAll(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("rasterizes SVG into a regular PNG attachment", async () => {
		const path = join(directory, "sample.svg");
		writeFileSync(
			path,
			'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>',
		);

		const result = await preprocessLocalFile(path);

		expect(result?.kind).toBe("image");
		expect(result?.images, result?.text).toHaveLength(1);
		expect(result?.images[0]?.mimeType).toBe("image/png");
	});

	it.each(["tiff", "avif"] as const)("converts %s into a regular image attachment", async (format) => {
		const path = join(directory, `sample.${format === "tiff" ? "tiff" : "avif"}`);
		const source = sharp({
			create: { width: 2, height: 2, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
		});
		writeFileSync(path, format === "tiff" ? await source.tiff().toBuffer() : await source.avif().toBuffer());

		const result = await preprocessLocalFile(path);

		expect(result?.kind).toBe("image");
		expect(result?.images).toHaveLength(1);
		expect(result?.images[0]?.mimeType).toBe("image/png");
	});

	it("converts animated PNG into a regular image attachment", async () => {
		const ffmpegPath = require("ffmpeg-static") as string | null;
		// ffmpeg-static resolves to a path even when its postinstall download failed;
		// skip when the binary is actually missing instead of failing the suite.
		if (!ffmpegPath || !existsSync(ffmpegPath)) return;
		const path = join(directory, "sample.apng");
		execFileSync(ffmpegPath, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc=size=16x16:rate=2:duration=1",
			"-plays",
			"0",
			"-y",
			path,
		]);

		const result = await preprocessLocalFile(path);

		expect(result?.kind).toBe("image");
		expect(result?.images).toHaveLength(1);
		expect(result?.images[0]?.mimeType).toBe("image/png");
	});

	it("extracts DOCX text without treating the ZIP container as UTF-8", async () => {
		const path = join(directory, "sample.docx");
		writeFileSync(path, createMinimalDocx("文档里的真实文字"));

		const result = await preprocessLocalFile(path);

		expect(result?.kind).toBe("document");
		expect(result?.text).toContain("文档里的真实文字");
	});

	it("keeps the same Office corpus access token when preprocessing options change", async () => {
		const path = join(directory, "stable-token.docx");
		const corpusDirectory = join(directory, "stable-office-corpus");
		writeFileSync(path, createMinimalDocx("需要稳定引用的正文"));

		const first = await preprocessLocalFile(path, { documentCorpusDirectory: corpusDirectory, includeImages: true });
		const firstManifest = JSON.parse(readFileSync(first!.documentManifestPath!, "utf8")) as {
			accessToken: string;
			units: Array<{ sourceType?: string; label: string }>;
		};
		const second = await preprocessLocalFile(path, {
			documentCorpusDirectory: corpusDirectory,
			includeImages: false,
		});
		const secondManifest = JSON.parse(readFileSync(second!.documentManifestPath!, "utf8")) as {
			accessToken: string;
			units: Array<{ sourceType?: string; label: string }>;
		};

		expect(secondManifest.accessToken).toBe(firstManifest.accessToken);
		expect(secondManifest.units.some((unit) => unit.sourceType === "paragraph" || unit.label.includes("正文"))).toBe(
			true,
		);
	});

	it("reuses the same Office corpus when the Windows path casing differs", async () => {
		if (process.platform !== "win32") return;
		const path = join(directory, "stable-windows-case.docx");
		const corpusDirectory = join(directory, "stable-windows-case-corpus");
		writeFileSync(path, createMinimalDocx("大小写稳定的正文"));

		const first = await preprocessLocalFile(path, { documentCorpusDirectory: corpusDirectory, includeImages: false });
		// Only the drive-letter casing changes: the same file on Windows.
		const alternate = path.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
		expect(alternate).not.toBe(path);
		const second = await preprocessLocalFile(alternate, {
			documentCorpusDirectory: corpusDirectory,
			includeImages: false,
		});

		expect(second?.documentManifestPath).toBe(first?.documentManifestPath);
		const firstManifest = JSON.parse(readFileSync(first!.documentManifestPath!, "utf8")) as { accessToken: string };
		const secondManifest = JSON.parse(readFileSync(second!.documentManifestPath!, "utf8")) as { accessToken: string };
		expect(secondManifest.accessToken).toBe(firstManifest.accessToken);
	});

	it.each([
		["xlsx", createMinimalXlsx],
		["pptx", createMinimalPptx],
	] as const)("extracts text from %s files", async (extension, createFile) => {
		const path = join(directory, `sample.${extension}`);
		writeFileSync(path, createFile(`${extension.toUpperCase()} 里的文字`));

		const result = await preprocessLocalFile(path);

		expect(result?.kind).toBe("document");
		expect(result?.text).toContain(`${extension.toUpperCase()} 里的文字`);
	});

	it("extracts PDF text and renders its page", async () => {
		const path = join(directory, "sample.pdf");
		writeFileSync(path, createMinimalPdf("PDF content"));

		const result = await preprocessLocalFile(path);

		expect(result?.kind).toBe("pdf");
		expect(result?.text).toContain("PDF content");
		expect(result?.images).toHaveLength(1);
	});

	it("extracts text from every PDF page while rendering only the visual page budget", async () => {
		const path = join(directory, "many-pages.pdf");
		const pageTexts = Array.from({ length: 15 }, (_, index) => `PAGE_${index + 1}`);
		writeFileSync(path, createMultiPagePdf(pageTexts));
		const corpusDirectory = join(directory, "document-corpus");

		const result = await preprocessLocalFile(path, { documentCorpusDirectory: corpusDirectory });

		expect(result?.kind).toBe("pdf");
		expect(result?.text).toContain("PAGE_15");
		expect(result?.text).toContain("提取全部页面文字");
		expect(result?.images).toHaveLength(12);
		expect(result?.documentManifestPath).toBeTruthy();
		const manifest = JSON.parse(readFileSync(result!.documentManifestPath!, "utf8")) as {
			status: string;
			totalUnits: number;
			completedUnits: number;
			units: Array<{ label: string; imagePath?: string }>;
		};
		expect(manifest.status).toBe("complete");
		expect(manifest.totalUnits).toBe(15);
		expect(manifest.completedUnits).toBe(15);
		expect(manifest.units).toHaveLength(15);
		expect(manifest.units[14]?.label).toContain("many-pages.pdf · 第 15 页");
		expect(manifest.units.every((unit) => unit.imagePath && readFileSync(unit.imagePath).length > 0)).toBe(true);
	});

	it("can extract rich-file text without producing visual attachments", async () => {
		const path = join(directory, "text-only.pdf");
		writeFileSync(path, createMinimalPdf("TEXT_ONLY"));

		const result = await preprocessLocalFile(path, { includeImages: false });

		expect(result?.text).toContain("TEXT_ONLY");
		expect(result?.images).toHaveLength(0);
		expect(result?.text).toContain("未渲染页面图片");
	});

	it("honors an already-aborted preprocessing request", async () => {
		const path = join(directory, "aborted.pdf");
		writeFileSync(path, createMinimalPdf("ABORT"));
		const controller = new AbortController();
		controller.abort(new Error("cancelled by test"));

		await expect(preprocessLocalFile(path, { signal: controller.signal })).rejects.toThrow("cancelled by test");
	});

	it("rejects a file above an explicitly configured single-file limit before parsing", async () => {
		const path = join(directory, "limited.pdf");
		writeFileSync(path, createMinimalPdf("LIMIT"));

		const result = await preprocessLocalFile(path, { maxInputBytes: 1 });

		expect(result?.kind).toBe("pdf");
		expect(result?.text).toContain("超过当前");
		expect(result?.images).toHaveLength(0);
	});

	it("renders the PSD composite image", async () => {
		const path = join(directory, "sample.psd");
		writeFileSync(
			path,
			writePsdBuffer({
				width: 1,
				height: 1,
				imageData: { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) },
			}),
		);

		const result = await preprocessLocalFile(path);

		expect(result?.kind).toBe("image");
		expect(result?.images, result?.text).toHaveLength(1);
	});

	it("decodes JPEG XL through the bundled decoder", async () => {
		const pngPath = join(directory, "jxl-source.png");
		const jxlPath = join(directory, "sample.jxl");
		writeFileSync(
			pngPath,
			await sharp({
				create: { width: 2, height: 2, channels: 4, background: { r: 200, g: 50, b: 10, alpha: 1 } },
			})
				.png()
				.toBuffer(),
		);
		execFileSync(process.execPath, [
			"-e",
			"global.fetch=undefined; require(process.argv[1]);",
			require.resolve("jxl-wasm/lib/cjxl-wrap.js"),
			pngPath,
			jxlPath,
		]);

		const result = await preprocessLocalFile(jxlPath);

		expect(result?.kind).toBe("image");
		expect(result?.images).toHaveLength(1);
	});

	it("extracts video keyframes and leaves audio out of scope", async () => {
		const ffmpegPath = require("ffmpeg-static") as string | null;
		// ffmpeg-static resolves to a path even when its postinstall download failed;
		// skip when the binary is actually missing instead of failing the suite.
		if (!ffmpegPath || !existsSync(ffmpegPath)) return;
		const videoPath = join(directory, "sample.mp4");
		execFileSync(ffmpegPath, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=32x32:d=1",
			"-pix_fmt",
			"yuv420p",
			"-y",
			videoPath,
		]);

		const result = await preprocessLocalFile(videoPath);

		expect(result?.kind).toBe("video");
		expect(result?.images.length).toBeGreaterThan(0);
		expect(result?.text).toContain("未处理音轨");
	});

	it("returns a clear message instead of reading audio as text", async () => {
		const path = join(directory, "sample.mp3");
		writeFileSync(path, Buffer.from([0x49, 0x44, 0x33]));

		const result = await preprocessLocalFile(path);

		expect(result?.kind).toBe("unsupported");
		expect(result?.text).toContain("未启用音频处理");
		expect(result?.images).toHaveLength(0);
	});

	it("uses the same preprocessor for @file arguments", async () => {
		const path = join(directory, "argument.svg");
		writeFileSync(
			path,
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="5"/></svg>',
		);

		const result = await processFileArguments([path]);

		expect(result.images).toHaveLength(1);
		expect(result.text).toContain("转换为 PNG");
	});

	it("recursively ingests document directories without embedding every page preview", async () => {
		const collectionDirectory = join(directory, "document-collection");
		const corpusDirectory = join(directory, "collection-corpus");
		for (let index = 1; index <= 5; index++) {
			const nestedDirectory = join(collectionDirectory, `group-${Math.ceil(index / 2)}`);
			mkdirSync(nestedDirectory, { recursive: true });
			writeFileSync(join(nestedDirectory, `document-${index}.pdf`), createMinimalPdf(`DOCUMENT_${index}`));
		}

		const result = await processFileArguments([collectionDirectory], { documentCorpusDirectory: corpusDirectory });

		expect(result.images).toHaveLength(0);
		expect(result.text.match(/<myharness-document-manifest>/g)).toHaveLength(5);
		expect(result.text).toContain("document-1.pdf");
		expect(result.text).toContain("document-5.pdf");
		expect(result.text).not.toContain("DOCUMENT_1");
	});

	it("recursively discovers ordinary images and continues after an invalid file", async () => {
		const collectionDirectory = join(directory, "mixed-image-collection");
		mkdirSync(collectionDirectory, { recursive: true });
		await sharp({
			create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 30, b: 40 } },
		})
			.png()
			.toFile(join(collectionDirectory, "visible.png"));

		const result = await processFileArguments([join(collectionDirectory, "missing.pdf"), collectionDirectory]);

		expect(result.images).toHaveLength(1);
		expect(result.text).toContain("文件不存在");
		expect(result.text).toContain("其余文件已继续处理");
	});

	it("uses the same preprocessor in the local Read tool", async () => {
		const path = join(directory, "read.docx");
		writeFileSync(path, createMinimalDocx("Read 工具提取的文字"));

		const result = await createReadTool(directory).execute("read-rich-file", { path });
		const text = result.content.find((item) => item.type === "text");

		expect(text?.type).toBe("text");
		if (text?.type === "text") expect(text.text).toContain("Read 工具提取的文字");
	});

	it("does not attach the same rich-file images again when Read continues from an offset", async () => {
		const path = join(directory, "continued.pdf");
		writeFileSync(path, createMinimalPdf("CONTINUED"));

		const result = await createReadTool(directory).execute("read-rich-file-offset", { path, offset: 2 });

		expect(result.content.some((item) => item.type === "image")).toBe(false);
	});
});
