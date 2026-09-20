import { isIP } from "node:net";

const TRACKING_QUERY_PARAMETERS = new Set([
	"fbclid",
	"gclid",
	"mc_cid",
	"mc_eid",
	"ref",
	"ref_src",
	"utm_campaign",
	"utm_content",
	"utm_medium",
	"utm_source",
	"utm_term",
]);

export interface UrlValidationResult {
	ok: boolean;
	url?: string;
	hostname?: string;
	code?: "invalid_url" | "unsupported_protocol" | "credentials" | "private_address";
	message?: string;
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const value = parts.reduce((result, part) => result * 256 + part, 0);
	return (
		(value >= 0x00000000 && value <= 0x00ffffff) ||
		(value >= 0x0a000000 && value <= 0x0affffff) ||
		(value >= 0x64400000 && value <= 0x647fffff) ||
		(value >= 0x7f000000 && value <= 0x7fffffff) ||
		(value >= 0xa9fe0000 && value <= 0xa9feffff) ||
		(value >= 0xac100000 && value <= 0xac1fffff) ||
		(value >= 0xc0000000 && value <= 0xc00000ff) ||
		(value >= 0xc0000200 && value <= 0xc00002ff) ||
		(value >= 0xc0a80000 && value <= 0xc0a8ffff) ||
		(value >= 0xc6120000 && value <= 0xc613ffff) ||
		(value >= 0xc6336400 && value <= 0xc63364ff) ||
		(value >= 0xcb007100 && value <= 0xcb0071ff) ||
		(value >= 0xe0000000 && value <= 0xffffffff)
	);
}

function isPrivateIpv6(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	if (normalized.startsWith("::ffff:")) {
		const mapped = normalized.slice("::ffff:".length);
		const dotted = mapped.includes(".")
			? mapped
			: (() => {
					const parts = mapped.split(":");
					if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return undefined;
					const high = Number.parseInt(parts[0]!, 16);
					const low = Number.parseInt(parts[1]!, 16);
					return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
				})();
		if (dotted && isPrivateIpv4(dotted)) return true;
	}
	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("ff") ||
		normalized.startsWith("2001:db8") ||
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb")
	);
}

function isPrivateAddress(hostname: string): boolean {
	const lower = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
	if (lower === "localhost" || lower.endsWith(".localhost") || lower === "local") return true;
	const ipVersion = isIP(lower);
	return ipVersion === 4 ? isPrivateIpv4(lower) : ipVersion === 6 ? isPrivateIpv6(lower) : false;
}

/** Validate a URL before it is sent to a remote search/crawl service. */
export function validatePublicHttpUrl(input: string): UrlValidationResult {
	let parsed: URL;
	try {
		parsed = new URL(input.trim());
	} catch {
		return { ok: false, code: "invalid_url", message: "URL 格式无效。" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, code: "unsupported_protocol", message: "只允许 http:// 或 https:// URL。" };
	}
	if (parsed.username || parsed.password) {
		return { ok: false, code: "credentials", message: "URL 不允许携带用户名或密码。" };
	}
	if (isPrivateAddress(parsed.hostname)) {
		return { ok: false, code: "private_address", message: "出于 SSRF 安全原因，禁止访问本机或私有地址。" };
	}
	parsed.hash = "";
	return { ok: true, url: parsed.toString(), hostname: parsed.hostname.toLowerCase().replace(/\.$/u, "") };
}

/** Stable key used for deduplication and the session-scoped response cache. */
export function canonicalizeHttpUrl(input: string): string {
	const validation = validatePublicHttpUrl(input);
	if (!validation.ok || !validation.url) throw new Error(validation.message ?? "URL 无效。");
	const parsed = new URL(validation.url);
	if (parsed.hostname.startsWith("www.")) parsed.hostname = parsed.hostname.slice(4);
	for (const key of [...parsed.searchParams.keys()]) {
		if (TRACKING_QUERY_PARAMETERS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
			parsed.searchParams.delete(key);
		}
	}
	const sortedParameters = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
	parsed.search = "";
	for (const [key, value] of sortedParameters) parsed.searchParams.append(key, value);
	const result = parsed.toString();
	return result.length > parsed.origin.length + 1 && result.endsWith("/") ? result.slice(0, -1) : result;
}

export function normalizeAllowedDomain(input: string): string | undefined {
	const trimmed = input.trim().toLowerCase().replace(/^\.+/u, "").replace(/\.$/u, "");
	if (!trimmed || trimmed.includes("/") || trimmed.includes(":") || trimmed.includes("@")) return undefined;
	if (trimmed === "localhost" || isPrivateAddress(trimmed)) return undefined;
	return trimmed;
}

export function isHostnameAllowed(hostname: string, domains: readonly string[]): boolean {
	const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, "");
	return domains.some((domain) => {
		const normalizedDomain = normalizeAllowedDomain(domain);
		return Boolean(
			normalizedDomain &&
				(normalizedHostname === normalizedDomain || normalizedHostname.endsWith(`.${normalizedDomain}`)),
		);
	});
}

export function isFreshnessSensitiveQuery(query: string): boolean {
	return /(?:\b(?:latest|today|now|current|recent|breaking)\b|最新|今天|现在|当前|刚刚)/iu.test(query);
}
