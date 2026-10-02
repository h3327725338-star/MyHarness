import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { documentToMarkdown } from "../src/tools/web-search/document.ts";
import { readPage } from "../src/tools/web-search/page.ts";

function pdf(text: string): Buffer {
	const stream = text ? `BT /F1 24 Tf 50 100 Td (${text}) Tj ET` : "";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let body = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(body));
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	return Buffer.from(`${body}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

const lookup = async () => ["93.184.216.34"];
const fetchDocument = (body: Uint8Array, type: string) =>
	readPage("https://example.com/document", {
		lookup,
		fetchImpl: async () => new Response(Buffer.from(body), { headers: { "Content-Type": type } }),
	});

describe("web document extraction", () => {
	it("extracts a PDF response and also recognizes its signature without the correct MIME", async () => {
		for (const mime of ["application/pdf", "application/octet-stream"]) {
			const page = await fetchDocument(pdf("Readable PDF body"), mime);
			expect(page.markdown).toContain("Readable PDF body");
			expect(page.truncated).toBe(false);
		}
	});
	it("reports PDFs without a text layer and damaged PDFs without throwing", async () => {
		expect((await fetchDocument(pdf(""), "application/pdf")).markdown).toContain("扫描件");
		expect((await fetchDocument(Buffer.from("%PDF-1.7 damaged"), "application/pdf")).markdown).toContain("已损坏");
	});
	it("extracts a modern Word document from downloaded bytes", async () => {
		const bytes = zipSync({
			"[Content_Types].xml": strToU8(
				'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
			),
			"_rels/.rels": strToU8(
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			),
			"word/document.xml": strToU8(
				'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Readable Word body</w:t></w:r></w:p></w:body></w:document>',
			),
		});
		expect(
			(await fetchDocument(bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
				.markdown,
		).toContain("Readable Word body");
	});
	it("keeps cancellation semantics", async () => {
		await expect(documentToMarkdown(pdf("body"), AbortSignal.abort())).rejects.toMatchObject({ code: "aborted" });
	});
	it("reports password protection without attempting to unlock it", async () => {
		const { OfficeParser } = await import("officeparser");
		const parse = vi.spyOn(OfficeParser, "parseOffice").mockRejectedValueOnce(new Error("Password required"));
		try {
			expect((await documentToMarkdown(pdf("body"))).markdown).toContain("密码保护");
		} finally {
			parse.mockRestore();
		}
	});
});
