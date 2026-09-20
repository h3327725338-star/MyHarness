import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Shared text redaction for persisted diagnostics and runtime traces.
 *
 * This module deliberately does not impose a length limit. Callers that own a
 * resource boundary may apply their own cap after redaction; Final Report
 * diagnostics preserve the complete text already captured by the executor.
 *
 * 分页场景（Review Check artifact）与整段文本共用同一组 redaction 规则：
 * findDiagnosticRedactionSpans 是唯一事实源，sanitizeDiagnosticText 与
 * ArtifactStore 的 streaming 投影都基于它，避免两套规则漂移。
 */
/**
 * credential key 的单一事实源（whole-text regex 与 streaming sanitizer 共用）。
 * 覆盖 api_key / api-key / apikey、access_token、auth/authorization、bearer、
 * cookie、credential、password、passphrase、private_key、secret。
 */
const CREDENTIAL_KEY_ALTERNATION =
	"api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|cookie|credential|password|passphrase|private[_-]?key|secret";

const CREDENTIAL_VALUE_PATTERN = new RegExp(
	`((?:${CREDENTIAL_KEY_ALTERNATION})\\s*(?:[:=]\\s*|\\s+))(["']?)[^\\s;&|"']+\\2`,
	"gi",
);

const SECRET_VALUE_PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{12,}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
	/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
	CREDENTIAL_VALUE_PATTERN,
];

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:[\\/][^\s\n\r)\]}>,;]*/gu;
const POSIX_ABSOLUTE_PATH = /(^|[\s=(,:])\/(?:[^\s\n\r)\]}>,;]*)/gu;

export type DiagnosticRedactionKind = "secret" | "path" | "control";

/** 文本中需要 redact 的 span（UTF-16 code unit 区间，已对齐到完整 codepoint）。 */
export interface DiagnosticRedactionSpan {
	start: number;
	end: number;
	kind: DiagnosticRedactionKind;
}

function redactionKindPriority(kind: DiagnosticRedactionKind): number {
	return kind === "secret" ? 2 : kind === "path" ? 1 : 0;
}

export function redactionReplacement(kind: DiagnosticRedactionKind): string {
	return kind === "secret" ? "[REDACTED]" : kind === "path" ? "[absolute path omitted]" : "";
}

/** span 边界不能切在 surrogate pair 中间，否则输出会残留孤立 surrogate。 */
function alignSpanToCodePoints(text: string, start: number, end: number): { start: number; end: number } {
	let alignedStart = start;
	let alignedEnd = end;
	const startCode = text.charCodeAt(alignedStart);
	if (startCode >= 0xdc00 && startCode <= 0xdfff && alignedStart > 0) {
		const previous = text.charCodeAt(alignedStart - 1);
		if (previous >= 0xd800 && previous <= 0xdbff) alignedStart -= 1;
	}
	if (alignedEnd < text.length) {
		const endCode = text.charCodeAt(alignedEnd);
		if (endCode >= 0xdc00 && endCode <= 0xdfff && alignedEnd > 0) {
			const previous = text.charCodeAt(alignedEnd - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) alignedEnd += 1;
		}
	}
	return { start: alignedStart, end: alignedEnd };
}

/**
 * 返回 value 中所有需要 redact 的 span，已排序并合并重叠/相邻区间。
 * POSIX absolute path 的前缀分隔符（group 1）不属于 span，会原样保留。
 */
export function findDiagnosticRedactionSpans(value: string): DiagnosticRedactionSpan[] {
	const spans: DiagnosticRedactionSpan[] = [];
	const addMatch = (match: RegExpMatchArray, kind: DiagnosticRedactionKind, prefixLength = 0): void => {
		const index = (match.index ?? 0) + prefixLength;
		const end = (match.index ?? 0) + match[0].length;
		if (index >= end) return;
		const aligned = alignSpanToCodePoints(value, index, end);
		spans.push({ start: aligned.start, end: aligned.end, kind });
	};
	for (const pattern of SECRET_VALUE_PATTERNS) {
		for (const match of value.matchAll(pattern)) addMatch(match, "secret");
	}
	for (const match of value.matchAll(ANSI_ESCAPE)) addMatch(match, "control");
	for (const match of value.matchAll(WINDOWS_ABSOLUTE_PATH)) addMatch(match, "path");
	for (const match of value.matchAll(POSIX_ABSOLUTE_PATH)) {
		addMatch(match, "path", match[1]?.length ?? 0);
	}
	return mergeDiagnosticRedactionSpans(spans);
}

/** 排序并合并重叠/相邻的 redaction span；重叠时保留更严格的 kind（secret > path > control）。 */
export function mergeDiagnosticRedactionSpans(spans: readonly DiagnosticRedactionSpan[]): DiagnosticRedactionSpan[] {
	const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: DiagnosticRedactionSpan[] = [];
	for (const span of sorted) {
		const last = merged[merged.length - 1];
		if (last && span.start <= last.end) {
			last.end = Math.max(last.end, span.end);
			if (redactionKindPriority(span.kind) > redactionKindPriority(last.kind)) last.kind = span.kind;
		} else {
			merged.push({ ...span });
		}
	}
	return merged;
}

export function redactSensitiveText(value: string): string {
	let result = value;
	for (const pattern of SECRET_VALUE_PATTERNS) result = result.replace(pattern, "[REDACTED]");
	return result;
}

/** Remove terminal control codes, secrets and absolute environment paths without truncating diagnostics. */
export function sanitizeDiagnosticText(value: string): string {
	const spans = findDiagnosticRedactionSpans(value);
	if (spans.length === 0) return value.trim();
	let result = "";
	let cursor = 0;
	for (const span of spans) {
		result += value.slice(cursor, span.start);
		result += redactionReplacement(span.kind);
		cursor = span.end;
	}
	result += value.slice(cursor);
	return result.trim();
}

/**
 * Streaming redaction state machine，供 ArtifactStore 把任意大小的 raw artifact
 * 增量转换为 sanitized view。
 *
 * 与 whole-text sanitizeDiagnosticText 不同：这里不把整段文本载入内存，而是
 * 维护有限状态；一旦确认进入 sensitive state，在明确终止符出现前不得恢复普通
 * 输出（fail-closed），因此 secret 任意长都不会泄漏。
 */
export type StreamingRedactionMode =
	| "normal"
	| "ansi"
	| "sk-candidate"
	| "sk-secret"
	| "bearer-await-token"
	| "bearer-secret"
	| "credential-await-value"
	| "credential-secret"
	| "pem-secret"
	| "windows-path"
	| "posix-path";

export interface DiagnosticSanitizingTransformOptions {
	/** NORMAL 模式用于敏感 start-marker 检测的有限前缀缓冲（字符数）。 */
	prefixBufferSize?: number;
}

const STREAMING_PREFIX_BUFFER_CHARS = 256;
/** 所有敏感 start marker 完成判定所需的最大字符数（含 \\b 前一个字符），远小于缓冲。 */
const SK_SECRET_THRESHOLD = 12;
const PEM_TAIL_BUFFER_CHARS = 128;
const SK_TOKEN_CHAR = /[A-Za-z0-9_-]/u;
const BEARER_TOKEN_CHAR = /[A-Za-z0-9._~+/=-]/u;
const PATH_TERMINATOR = /[\s)\]}>,;]/u;

const ANSI_START = /\u001b\[/u;
const PEM_START = /-----BEGIN /u;
const SK_START = /\bsk-/u;
// marker-only：NORMAL 只负责识别 "Bearer" marker（后面紧接 whitespace 即可确认），
// 不吞 whitespace、不依赖真实 token 是否已到达；任意长度 separator/token 由
// bearer-await-token / bearer-secret 负责（不受 NORMAL 256-char buffer 限制）。
const BEARER_START = /\bBearer(?=\s)/iu;
// marker-only：只识别 credential keyword，并确认其后已出现合法 separator 起点
// （whitespace / : / =）。不带 \b（与 whole-text CREDENTIAL_VALUE_PATTERN 的
// key 匹配范围一致）；separator 与 value 由 credential-await-value 处理。
const CREDENTIAL_START = new RegExp(`(?:${CREDENTIAL_KEY_ALTERNATION})(?=\\s|[:=])`, "iu");
const WINDOWS_START = /\b[A-Za-z]:[\\/]/u;
const POSIX_START = /([\s=(,:])\//u;
const POSIX_START_AT_BEGINNING = /(^|[\s=(,:])\//u;

interface StartHit {
	index: number;
	mode: StreamingRedactionMode;
	markerLength: number;
	replacement: string;
	/** POSIX path 命中时 group1（允许前缀分隔符）；无 group1 时 undefined。 */
	group1?: string;
}

function findEarliestStart(pending: string, atStart: boolean): StartHit | undefined {
	let earliest: StartHit | undefined;
	const consider = (mode: StreamingRedactionMode, match: RegExpMatchArray | null, replacement: string): void => {
		if (!match || match.index === undefined) return;
		const hit: StartHit = { index: match.index, mode, markerLength: match[0].length, replacement };
		if (!earliest || hit.index < earliest.index) earliest = hit;
	};
	consider("ansi", pending.match(ANSI_START), "");
	consider("pem-secret", pending.match(PEM_START), "[REDACTED]");
	consider("sk-candidate", pending.match(SK_START), "");
	consider("bearer-await-token", pending.match(BEARER_START), "[REDACTED]");
	consider("credential-await-value", pending.match(CREDENTIAL_START), "[REDACTED]");
	consider("windows-path", pending.match(WINDOWS_START), "[absolute path omitted]");
	const posix = pending.match(atStart ? POSIX_START_AT_BEGINNING : POSIX_START);
	if (posix?.index !== undefined) {
		const group1 = posix[1] ?? "";
		const hit: StartHit = {
			index: posix.index,
			mode: "posix-path",
			markerLength: posix[0].length,
			replacement: "[absolute path omitted]",
			group1,
		};
		if (!earliest || hit.index < earliest.index) earliest = hit;
	}
	return earliest;
}

/**
 * 创建把 raw artifact 流转换为安全视图的 Transform。
 *
 * - NORMAL 模式保留有限 prefix buffer 只做 start-marker 检测，不限制 secret 长度；
 * - 一旦进入 sensitive state，在明确终止符出现前持续丢弃（fail-closed）；
 * - PEM 只保留 END marker 检测所需的有限尾部 buffer；
 * - 跨 chunk 的 UTF-8 多字节序列由 StringDecoder 处理。
 */
export function createDiagnosticSanitizingTransform(options: DiagnosticSanitizingTransformOptions = {}): Transform {
	const prefixBufferSize = options.prefixBufferSize ?? STREAMING_PREFIX_BUFFER_CHARS;
	const decoder = new StringDecoder("utf8");
	let pending = "";
	let atStart = true;
	let mode: StreamingRedactionMode = "normal";
	let quote: string | undefined;
	let skCandidate = "";
	let pemTail = "";
	// credential value 首 token 的有界缓冲（最多 6 字符，足够判断 Bearer，不缓存 secret）。
	let credentialFirstToken = "";

	/** 把 pending 中所有可判定字符消费掉；恢复 normal 时剩余字符留在 pending 交给 normal 处理。 */
	const consumeMode = (): string => {
		let out = "";
		let index = 0;
		switch (mode) {
			case "ansi": {
				while (index < pending.length) {
					const code = pending.charCodeAt(index);
					if (code >= 0x40 && code <= 0x7e) {
						// CSI final byte：序列完成，丢弃；之后恢复普通输出。
						index++;
						mode = "normal";
						break;
					}
					if (code >= 0x20 && code <= 0x3f) {
						index++;
						continue;
					}
					// 非法序列字符：ESC [ 已丢弃，剩余字符按普通文本处理（fail-closed 方向）。
					index++;
					mode = "normal";
					break;
				}
				pending = pending.slice(index);
				break;
			}
			case "sk-candidate": {
				while (index < pending.length) {
					const char = pending[index]!;
					if (SK_TOKEN_CHAR.test(char)) {
						skCandidate += char;
						index++;
						if (skCandidate.length > SK_SECRET_THRESHOLD) {
							// 第 13 个 token char 确认是长 token：立即 redact 并进入 sk-secret。
							out += "[REDACTED]";
							mode = "sk-secret";
							break;
						}
						continue;
					}
					if (skCandidate.length >= SK_SECRET_THRESHOLD) out += "[REDACTED]";
					else out += `sk-${skCandidate}`;
					skCandidate = "";
					mode = "normal";
					pending = pending.slice(index);
					return out;
				}
				pending = pending.slice(index);
				break;
			}
			case "sk-secret":
			case "bearer-secret": {
				const tokenChar = mode === "sk-secret" ? SK_TOKEN_CHAR : BEARER_TOKEN_CHAR;
				while (index < pending.length) {
					if (tokenChar.test(pending[index]!)) {
						index++;
						continue;
					}
					mode = "normal";
					pending = pending.slice(index);
					return out;
				}
				pending = "";
				break;
			}
			case "credential-await-value": {
				// credential marker 之后是 separator + optional whitespace + value 的完整 owner：
				// whitespace 与 : / = 一律消费并继续等待（任意长度、跨多个 chunk，不依赖 NORMAL
				// prefix buffer）；重复 delimiter（password ::= SECRET）也继续等待（fail-closed）。
				// 只有 quote 或第一个普通 value 字符才离开本状态。
				while (index < pending.length) {
					const char = pending[index]!;
					if (/\s/u.test(char) || char === ":" || char === "=") {
						index++;
						continue;
					}
					if (char === '"' || char === "'") {
						quote = char;
						mode = "credential-secret";
						index++;
						break;
					}
					// 第一个普通字符属于 secret：转入 credential-secret，该字符保留给
					// credential-secret 消费（不能输出）。
					mode = "credential-secret";
					pending = pending.slice(index);
					return out;
				}
				pending = pending.slice(index);
				break;
			}
			case "credential-secret": {
				while (index < pending.length) {
					const char = pending[index]!;
					if (quote !== undefined) {
						if (char === quote) {
							quote = undefined;
							index++;
							mode = "normal";
							break;
						}
						index++;
						continue;
					}
					if (char === '"' || char === "'") {
						quote = char;
						index++;
						continue;
					}
					if (/\s|[;&|'"]/u.test(char)) {
						// 无引号 value 的终止符保留（与 whole-text 语义一致）。
						// 特殊语义：value 的首 token 是 Bearer（忽略大小写）时，whitespace 不是
						// credential 的终止，转入 bearer-await-token 继续等待真正的 bearer token
						// （Authorization: Bearer TOKEN 组合场景，不能只 redact Bearer 而泄漏 TOKEN）。
						if (credentialFirstToken.toLowerCase() === "bearer" && /\s/u.test(char)) {
							credentialFirstToken = "";
							mode = "bearer-await-token";
							pending = pending.slice(index);
							return out;
						}
						credentialFirstToken = "";
						mode = "normal";
						pending = pending.slice(index);
						return out;
					}
					// token 字符：只累积首 token 的有界前缀（最多 6 字符），不缓存 secret 本身。
					if (credentialFirstToken.length < 6) credentialFirstToken += char;
					index++;
				}
				pending = pending.slice(index);
				break;
			}
			case "bearer-await-token": {
				// Bearer 标记之后等待真正的 token：whitespace 继续等待，不得恢复 normal
				// （Bearer 后跨 chunk 的任意数量空白都必须保持 fail-closed）。
				while (index < pending.length) {
					const char = pending[index]!;
					if (/\s/u.test(char)) {
						index++;
						continue;
					}
					if (BEARER_TOKEN_CHAR.test(char)) {
						mode = "bearer-secret";
						index++;
						break;
					}
					// 非 whitespace 非 token 字符：没有真正的 bearer token，恢复普通输出。
					mode = "normal";
					pending = pending.slice(index);
					return out;
				}
				pending = pending.slice(index);
				break;
			}
			case "pem-secret": {
				while (index < pending.length) {
					const char = pending[index]!;
					index++;
					pemTail = (pemTail + char).slice(-PEM_TAIL_BUFFER_CHARS);
					// END marker 以 '-' 结尾（-----END <name>-----）；只有 '-' 到达时才值得检查。
					if (char === "-") {
						const endMatch = pemTail.match(/-----END [^-]+-----$/u);
						if (endMatch) {
							pemTail = "";
							mode = "normal";
							pending = pending.slice(index);
							return out;
						}
					}
				}
				pending = "";
				break;
			}
			case "windows-path":
			case "posix-path": {
				while (index < pending.length) {
					if (PATH_TERMINATOR.test(pending[index]!)) {
						mode = "normal";
						pending = pending.slice(index);
						return out;
					}
					index++;
				}
				pending = "";
				break;
			}
			default:
				break;
		}
		return out;
	};

	const process = (text: string): string => {
		let out = "";
		pending += text;
		while (true) {
			if (mode === "normal") {
				const hit = findEarliestStart(pending, atStart);
				if (!hit) {
					if (pending.length > prefixBufferSize + 1) {
						const overflow = pending.length - prefixBufferSize - 1;
						out += pending.slice(0, overflow);
						pending = pending.slice(overflow);
						atStart = false;
					}
					break;
				}
				out += pending.slice(0, hit.index);
				if (hit.group1 !== undefined) out += hit.group1;
				out += hit.replacement;
				pending = pending.slice(hit.index + hit.markerLength);
				atStart = false;
				mode = hit.mode;
				if (mode === "sk-candidate") skCandidate = "";
				if (mode === "pem-secret") pemTail = "";
				if (mode === "credential-await-value") credentialFirstToken = "";
				continue;
			}
			out += consumeMode();
			if ((mode as StreamingRedactionMode) === "normal") continue;
			// 敏感状态链（await → secret → await → secret → normal）可能在同一批输入中
			// 连续转换（例如单 chunk 的 "Authorization: Bearer TOKEN\npublic"）：只要
			// pending 还有剩余字符就继续推进状态机，避免公共尾部被 flush 的 fail-closed
			// 误吞。pending 为空时 break，等待下一个 chunk。
			if (pending.length > 0) continue;
			break;
		}
		return out;
	};

	return new Transform({
		transform(chunk, _encoding, callback) {
			try {
				callback(null, process(decoder.write(chunk)));
			} catch (error) {
				callback(error as Error);
			}
		},
		flush(callback) {
			try {
				let out = process(decoder.end());
				if (mode === "sk-candidate") {
					// EOF 边界视为 word boundary：12 个 token chars 到 EOF 仍是完整 sk-* secret。
					out += skCandidate.length >= SK_SECRET_THRESHOLD ? "[REDACTED]" : `sk-${skCandidate}`;
					skCandidate = "";
					mode = "normal";
				}
				// 其他 sensitive state 到 EOF 保持 redacted（fail-closed）；PEM 无 END 时同理。
				if (mode === "normal") out += pending;
				pending = "";
				callback(null, out);
			} catch (error) {
				callback(error as Error);
			}
		},
	});
}
