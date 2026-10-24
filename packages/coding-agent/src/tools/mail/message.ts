import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { MailProvider } from "../../providers/credentials/mail-connections.ts";
import { resolveReadPath } from "../path-utils.ts";

/**
 * A message written by the agent in plain fields, turned into what each provider expects: an RFC 5322 message encoded
 * as base64url `raw` for Gmail, a Graph `message` object for Outlook. Models cannot reliably base64-encode text or
 * files themselves, so both encodings happen here.
 */
export interface MailMessageInput {
	to?: string[];
	cc?: string[];
	bcc?: string[];
	subject?: string;
	text?: string;
	html?: string;
	inReplyTo?: string;
	references?: string;
	/** Local file paths (relative to the working directory) sent as attachments. */
	attachments?: string[];
}

interface Attachment {
	name: string;
	contentType: string;
	bytes: Buffer;
}

const GRAPH_INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
const GMAIL_MESSAGE_LIMIT = 25 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".html": "text/html",
	".htm": "text/html",
	".json": "application/json",
	".pdf": "application/pdf",
	".zip": "application/zip",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function noLineBreaks(value: string, field: string): string {
	if (/[\r\n]/.test(value)) throw new Error(`message.${field} 不能包含换行符。`);
	return value;
}

/** RFC 2047 encoded-words for a header value with non-ASCII text, split so no character is cut in half. */
export function encodeHeaderWord(value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	const words: string[] = [];
	let chunk = "";
	for (const char of value) {
		if (Buffer.byteLength(chunk + char) > 45) {
			words.push(chunk);
			chunk = "";
		}
		chunk += char;
	}
	if (chunk) words.push(chunk);
	return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`).join("\r\n ");
}

/** "Name <address>" or a bare address, checked and split. */
function parseAddress(value: string, field: string): { name?: string; address: string } {
	const trimmed = noLineBreaks(value, field).trim();
	const match = trimmed.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);
	const name = match?.[1].trim().replace(/^"(.*)"$/, "$1");
	const address = match ? match[2] : trimmed;
	if (!/^[^\s@<>,;]+@[^\s@<>,;]+$/.test(address)) throw new Error(`message.${field} 中的地址无效：${value}`);
	return { ...(name ? { name } : {}), address };
}

function mimeAddress(value: string, field: string): string {
	const { name, address } = parseAddress(value, field);
	if (!name) return address;
	const shown = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : encodeHeaderWord(name);
	return `${shown} <${address}>`;
}

const base64Lines = (bytes: Buffer) => bytes.toString("base64").replace(/.{76}(?=.)/g, "$&\r\n");

async function loadAttachments(paths: string[] | undefined, cwd: string): Promise<Attachment[]> {
	const attachments: Attachment[] = [];
	for (const path of paths ?? []) {
		const resolved = resolveReadPath(path, cwd);
		let bytes: Buffer;
		try {
			bytes = await readFile(resolved);
		} catch {
			throw new Error(`无法读取附件：${path}`);
		}
		const name = basename(resolved);
		attachments.push({
			name,
			contentType: CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream",
			bytes,
		});
	}
	return attachments;
}

function mimePart(contentType: string, text: string): string {
	return [
		`Content-Type: ${contentType}; charset=UTF-8`,
		"Content-Transfer-Encoding: base64",
		"",
		base64Lines(Buffer.from(text, "utf8")),
	].join("\r\n");
}

function multipart(subtype: string, parts: string[]): string {
	const boundary = `myharness-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
	return [
		`Content-Type: multipart/${subtype}; boundary="${boundary}"`,
		"",
		...parts.map((part) => `--${boundary}\r\n${part}`),
		`--${boundary}--`,
		"",
	].join("\r\n");
}

/** The whole RFC 5322 message (CRLF line ends) for Gmail. Gmail fills in From with the connected address. */
export async function buildMimeMessage(message: MailMessageInput, cwd: string): Promise<string> {
	const headers: string[] = ["MIME-Version: 1.0"];
	for (const field of ["to", "cc", "bcc"] as const) {
		const list = message[field];
		if (list?.length) {
			const name = field === "to" ? "To" : field === "cc" ? "Cc" : "Bcc";
			headers.push(`${name}: ${list.map((value) => mimeAddress(value, field)).join(",\r\n ")}`);
		}
	}
	if (message.subject !== undefined)
		headers.push(`Subject: ${encodeHeaderWord(noLineBreaks(message.subject, "subject"))}`);
	if (message.inReplyTo) headers.push(`In-Reply-To: ${noLineBreaks(message.inReplyTo, "inReplyTo")}`);
	if (message.references) headers.push(`References: ${noLineBreaks(message.references, "references")}`);
	const bodies = [
		...(message.text !== undefined || message.html === undefined ? [mimePart("text/plain", message.text ?? "")] : []),
		...(message.html !== undefined ? [mimePart("text/html", message.html)] : []),
	];
	let content = bodies.length > 1 ? multipart("alternative", bodies) : bodies[0];
	const attachments = await loadAttachments(message.attachments, cwd);
	if (attachments.length) {
		content = multipart("mixed", [
			content,
			...attachments.map((file) => {
				const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
				return [
					`Content-Type: ${file.contentType}; name="${ascii}"`,
					`Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
					"Content-Transfer-Encoding: base64",
					"",
					base64Lines(file.bytes),
				].join("\r\n");
			}),
		]);
	}
	const raw = `${headers.join("\r\n")}\r\n${content}`;
	if (Buffer.byteLength(raw) > GMAIL_MESSAGE_LIMIT) throw new Error("邮件连同附件超过 25 MB，Gmail 无法发送。");
	return raw;
}

/** A Microsoft Graph message resource. Attachments go inline, which Graph allows below 3 MB. */
export async function buildGraphMessage(message: MailMessageInput, cwd: string): Promise<Record<string, unknown>> {
	const recipients = (list: string[] | undefined, field: string) =>
		list?.map((value) => {
			const { name, address } = parseAddress(value, field);
			return { emailAddress: { address, ...(name ? { name } : {}) } };
		});
	const attachments = await loadAttachments(message.attachments, cwd);
	if (attachments.reduce((total, file) => total + file.bytes.length, 0) > GRAPH_INLINE_ATTACHMENT_LIMIT)
		throw new Error("Outlook 单次请求内的附件合计须小于 3 MB；更大的文件请先上传到网盘再发送链接。");
	const result: Record<string, unknown> = {};
	if (message.subject !== undefined) result.subject = noLineBreaks(message.subject, "subject");
	if (message.html !== undefined || message.text !== undefined)
		result.body =
			message.html !== undefined
				? { contentType: "HTML", content: message.html }
				: { contentType: "Text", content: message.text };
	for (const [field, key] of [
		["to", "toRecipients"],
		["cc", "ccRecipients"],
		["bcc", "bccRecipients"],
	] as const) {
		const list = recipients(message[field], field);
		if (list?.length) result[key] = list;
	}
	if (attachments.length)
		result.attachments = attachments.map((file) => ({
			"@odata.type": "#microsoft.graph.fileAttachment",
			name: file.name,
			contentType: file.contentType,
			contentBytes: file.bytes.toString("base64"),
		}));
	return result;
}

/**
 * Puts the composed message where the endpoint expects it:
 * - Gmail: `raw` for messages/send|import|insert, `message.raw` for drafts.
 * - Graph: `message` for sendMail and the reply/forward actions, the body itself for creating or updating a message.
 */
export async function applyMessage(
	provider: MailProvider,
	path: string,
	body: Record<string, unknown> | undefined,
	message: MailMessageInput,
	cwd: string,
): Promise<Record<string, unknown>> {
	const pathname = path.split("?")[0].replace(/\/+$/, "");
	const base = { ...(body ?? {}) };
	const nested = (key: string) =>
		base[key] && typeof base[key] === "object" && !Array.isArray(base[key])
			? (base[key] as Record<string, unknown>)
			: {};
	if (provider === "google") {
		const raw = Buffer.from(await buildMimeMessage(message, cwd), "utf8").toString("base64url");
		return /\/drafts(\/[^/]+)?$/.test(pathname)
			? { ...base, message: { ...nested("message"), raw } }
			: { ...base, raw };
	}
	const graph = await buildGraphMessage(message, cwd);
	return /\/(sendMail|reply|replyAll|forward|createReply|createReplyAll|createForward)$/i.test(pathname)
		? { ...base, message: { ...nested("message"), ...graph } }
		: { ...base, ...graph };
}
