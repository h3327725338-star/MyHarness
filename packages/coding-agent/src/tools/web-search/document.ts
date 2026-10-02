import { abortError } from "./errors.ts";

/** Documents are parsed from the already bounded public HTTP response, never fetched again by a parser. */
export function isDocument(bytes: Uint8Array, contentType: string): boolean {
	return (
		/application\/(?:pdf|rtf|msword|vnd\.ms-(?:excel|powerpoint)|epub\+zip|vnd\.(?:openxmlformats-officedocument\.|oasis\.opendocument\.))/iu.test(
			contentType,
		) ||
		Buffer.from(bytes.subarray(0, 8)).toString("ascii").startsWith("%PDF-") ||
		Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "{\\rtf" ||
		(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
	);
}

export async function documentToMarkdown(
	bytes: Uint8Array,
	signal?: AbortSignal,
	contentType = "",
): Promise<{ markdown: string }> {
	const pdf =
		/application\/pdf/iu.test(contentType) || Buffer.from(bytes.subarray(0, 8)).toString("ascii").startsWith("%PDF-");
	try {
		if (signal?.aborted) throw abortError(signal);
		const { OfficeParser } = await import("officeparser");
		const ast = await OfficeParser.parseOffice(Buffer.from(bytes), {
			extractAttachments: false,
			ocr: false,
			includeRawContent: false,
			abortSignal: signal,
			decompressionLimits: { maxUncompressedBytes: 256 * 1024 * 1024, maxZipEntries: 5_000 },
		});
		const text = (await ast.to("text", { textConfig: { preserveLayout: true, renderNotes: true } })).value.trim();
		if (signal?.aborted) throw abortError(signal);
		return {
			markdown:
				text ||
				(pdf
					? "该 PDF 没有可提取的文字，可能是纯图片扫描件。当前网页读取不执行 OCR；请下载后使用 read 或视觉分析读取。"
					: "该文档没有可提取的正文文字，可能只包含图片。"),
		};
	} catch (error) {
		if (signal?.aborted) throw abortError(signal);
		const reason = error instanceof Error ? error.message : String(error);
		if (/password|encrypted|encryption/iu.test(reason)) {
			return { markdown: "该文档受密码保护，无法提取正文。请提供解除保护的副本；工具不会尝试破解密码。" };
		}
		if (pdf) return { markdown: "该 PDF 已损坏或无法解析，未能提取正文。请下载检查文件，或提供可读取的副本。" };
		return {
			markdown:
				"文档未能提取正文，可能已损坏或使用了尚无法解析的旧格式。请下载检查文件，或转换为 PDF、DOCX、XLSX、PPTX 等现代格式后重试。",
		};
	}
}
