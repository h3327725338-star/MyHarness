/**
 * Plain-language explanation of a failed model request.
 *
 * Provider SDKs and gateways report failures as raw text such as
 * `520 status code (no body)` or `read ECONNRESET`. Shown alone, that text says
 * nothing about what went wrong or what to do. `explainProviderError` turns it
 * into a Chinese sentence naming the cause and a next step, and keeps the raw
 * text at the end for troubleshooting.
 *
 * Only display text is produced here. Retry, recovery and fallback decisions
 * keep reading the raw `errorMessage` (see `isRetryableAssistantError` and
 * `policy.ts`), so this module never changes what is retried.
 */

/** Longest raw error kept in an explanation; provider bodies can be several KB of JSON. */
const MAX_RAW_CHARS = 300;

/** What an explanation starts with, so text that was already explained is never explained twice. */
const EXPLAINED_PREFIX = "模型请求失败：";

interface ErrorExplanation {
	cause: string;
	advice: string;
}

/** Gateway/CDN (Cloudflare-style) statuses: the gateway answered, the model service behind it did not. */
const GATEWAY_STATUS_CAUSES: Readonly<Record<number, string>> = {
	520: "模型服务提供商的网关与后端服务器之间连接异常（HTTP 520），后端返回了无法识别的响应或连接被意外断开",
	521: "模型服务提供商的网关连不上后端服务器（HTTP 521），后端服务可能已宕机或拒绝连接",
	522: "模型服务提供商的网关连接后端服务器超时（HTTP 522）",
	523: "模型服务提供商的网关找不到可用的后端服务器（HTTP 523）",
	524: "模型服务提供商的后端处理请求超时，网关等待太久后放弃（HTTP 524）",
	525: "模型服务提供商的网关与后端服务器 SSL 握手失败（HTTP 525）",
	526: "模型服务提供商的后端证书无效，网关拒绝连接（HTTP 526）",
	527: "模型服务提供商的网关与后端之间的专线连接出错（HTTP 527）",
	530: "模型服务提供商的网关无法解析或访问后端服务器（HTTP 530）",
};

const GATEWAY_ADVICE =
	"这通常是服务商或中转服务一侧的临时故障，与你的输入无关。系统已按设置自动重试；如果持续出现，请稍后再试、检查中转服务（Base URL）的状态，或在 /settings → Fallback Model 中配置备用模型。";

/** The HTTP status a raw provider error names, when it names one (4xx/5xx only). */
function extractStatus(raw: string): number | undefined {
	const patterns = [
		/^\s*(\d{3})\b/u, // "520 status code (no body)", "429 Too Many Requests"
		/\b(\d{3})\s+status code\b/iu,
		/\bHTTP(?:\/\d(?:\.\d)?)?\s*(?:status\s*)?:?\s*(\d{3})\b/iu,
		/\bstatus(?:\s*code)?\s*[:=]?\s*(\d{3})\b/iu,
		/\((\d{3})\)/u,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(raw);
		if (!match) continue;
		const status = Number(match[1]);
		if (status >= 400 && status < 600) return status;
	}
	return undefined;
}

function classify(raw: string): ErrorExplanation {
	const text = raw.trim();
	const status = extractStatus(text);
	const has = (pattern: RegExp) => pattern.test(text);

	if (
		has(
			/context.?(?:length|window)|maximum context|prompt is too long|too many tokens|exceeds? the (?:context|maximum)|上下文/iu,
		)
	) {
		return {
			cause: "对话内容超过了模型能处理的上下文长度上限",
			advice: "执行 /compact 压缩上下文后再试，或换用上下文更大的模型。",
		};
	}
	if (
		has(
			/insufficient_quota|quota exceeded|out of budget|usage limit|available balance|\bbilling\b|insufficient (?:balance|credit|funds)|余额不足|额度/iu,
		)
	) {
		return {
			cause: "模型服务账户的额度或余额不足（或已达到套餐用量上限）",
			advice: "到服务商控制台充值或检查套餐；也可以在 /settings 中换用其他 Provider 或配置备用模型。",
		};
	}
	if (
		status === 401 ||
		has(
			/unauthori[sz]ed|invalid.?api.?key|incorrect api key|api key (?:not valid|is invalid|expired)|authentication|invalid.?token|token (?:has )?expired|no api key/iu,
		)
	) {
		return {
			cause: "认证失败：API Key 或登录凭证无效、已过期或已被撤销",
			advice: "在 /settings → Providers 中重新填写 API Key 或重新登录该 Provider。",
		};
	}
	if (
		status === 403 ||
		has(/\bforbidden\b|permission denied|not allowed|access denied|unsupported (?:region|country)/iu)
	) {
		return {
			cause: "模型服务拒绝访问：当前账户没有使用该模型或接口的权限（也可能是地区限制）",
			advice: "确认账户已开通该模型；如果使用代理或中转服务，检查它允许访问的地区和模型。",
		};
	}
	if (status === 404 || has(/model.?not.?found|does not exist|no such model|unknown model/iu)) {
		return {
			cause: "找不到请求的模型或接口地址",
			advice: "检查模型 ID 是否正确、Provider 的 Base URL 是否填对，以及该模型是否已下线。",
		};
	}
	if (status === 429 || has(/rate.?limit|too many requests|resource.?exhausted/iu)) {
		return {
			cause: "请求过于频繁，被模型服务提供商限流",
			advice: "系统会按设置自动等待并重试；如果经常出现，请降低并发或升级服务商的速率限制。",
		};
	}
	if (status !== undefined && GATEWAY_STATUS_CAUSES[status]) {
		return { cause: GATEWAY_STATUS_CAUSES[status]!, advice: GATEWAY_ADVICE };
	}
	if (status === 529 || has(/overloaded/iu)) {
		return {
			cause: "模型服务当前负载过高，暂时无法处理请求",
			advice: "系统已自动重试；如果持续出现，请稍后再试或配置备用模型。",
		};
	}
	if (status === 502 || has(/bad.?gateway/iu)) {
		return {
			cause: "网关或中转代理没有从后端模型服务拿到有效响应（HTTP 502）",
			advice: GATEWAY_ADVICE,
		};
	}
	if (status === 503 || has(/service.?unavailable/iu)) {
		return {
			cause: "模型服务暂时不可用（可能在维护或过载，HTTP 503）",
			advice: GATEWAY_ADVICE,
		};
	}
	if (status === 504 || has(/gateway.?time.?out/iu)) {
		return {
			cause: "网关等待后端模型服务响应超时（HTTP 504）",
			advice: GATEWAY_ADVICE,
		};
	}
	if (status !== undefined && status >= 500) {
		return {
			cause: `模型服务内部出错（HTTP ${status}）`,
			advice: "这是服务商一侧的问题，系统已按设置自动重试；如果持续出现，请稍后再试或配置备用模型。",
		};
	}
	if (has(/ENOTFOUND|EAI_AGAIN|getaddrinfo/iu)) {
		return {
			cause: "无法解析模型服务的域名（DNS 查询失败）",
			advice: "检查网络连接、DNS 和代理设置（/settings 中的 httpProxy），以及 Provider 的 Base URL 是否正确。",
		};
	}
	if (has(/ECONNREFUSED|connection.?refused/iu)) {
		return {
			cause: "无法连接到模型服务：对方拒绝了连接",
			advice: "检查 Provider 的 Base URL 和端口、本地代理是否在运行，以及防火墙设置。",
		};
	}
	if (has(/certificate|self.?signed|\bSSL\b|\bTLS\b/iu)) {
		return {
			cause: "与模型服务建立安全连接（TLS/证书校验）失败",
			advice: "检查系统时间、代理或抓包软件是否替换了证书，以及 Base URL 是否使用了正确的 https 地址。",
		};
	}
	if (has(/ETIMEDOUT|timed? ?out|timeout/iu)) {
		return {
			cause: "网络请求超时：在规定时间内没有收到模型服务的响应",
			advice: "检查网络和代理是否稳定；如果模型需要长时间思考，可以在 /settings → HTTP idle timeout 中调大超时。",
		};
	}
	if (
		has(
			/ECONNRESET|socket hang up|other side closed|connection (?:reset|lost|error|closed)|socket connection was closed|fetch failed|network.?error|\bterminated\b|upstream.?connect|reset before headers|websocket/iu,
		)
	) {
		return {
			cause: "与模型服务的网络连接中途断开（网络不稳定，或代理/中转服务断开了连接）",
			advice: "系统已按设置自动重试；如果持续出现，请检查网络、代理或中转服务的稳定性。",
		};
	}
	if (has(/stream ended|ended without|ended before|premature|incomplete|http2 request did not get a response/iu)) {
		return {
			cause: "模型的流式响应在完成前被中断",
			advice: "这通常是服务商或网络的临时问题；可以直接重试，如果反复出现请稍后再试或配置备用模型。",
		};
	}
	if (has(/empty[ _-]?(?:response|reply|output|answer)|no usable output|无有效输出/iu)) {
		return {
			cause: "模型服务没有返回任何有效内容",
			advice: "可以重试；如果反复出现，换一个模型或配置备用模型。",
		};
	}
	if (status !== undefined && status >= 400) {
		return {
			cause: `请求被模型服务拒绝（HTTP ${status}），通常是请求参数或格式不被该模型接受`,
			advice: "该模型可能不支持当前用到的某些功能（如图片、工具调用或思考强度）；可以调整思考强度或换用其他模型。",
		};
	}
	return {
		cause: "模型服务返回了无法识别的错误",
		advice: "请查看下面的原始信息；如果反复出现，可以稍后再试、换个模型或配置备用模型。",
	};
}

function clipRaw(raw: string): string {
	const singleLine = raw.replace(/\s+/gu, " ").trim();
	return singleLine.length > MAX_RAW_CHARS ? `${singleLine.slice(0, MAX_RAW_CHARS)}…` : singleLine;
}

/** Whether the text is already an explanation produced by this module. */
export function isExplainedProviderError(text: string | undefined): boolean {
	return text?.startsWith(EXPLAINED_PREFIX) === true;
}

/**
 * Explain a failed model request in plain Chinese: the cause, what to do next,
 * and the raw provider text for troubleshooting. Text that is already an
 * explanation is returned unchanged.
 */
export function explainProviderError(raw: string | undefined): string {
	const text = raw?.trim() ?? "";
	if (isExplainedProviderError(text)) return text;
	if (!text) {
		return `${EXPLAINED_PREFIX}模型服务返回了错误，但没有提供任何错误信息。可以重试；如果反复出现，请稍后再试或配置备用模型。`;
	}
	const { cause, advice } = classify(text);
	const noBody = /\(no body\)|empty body|no response body/iu.test(text) ? "，并且没有返回任何错误说明" : "";
	return `${EXPLAINED_PREFIX}${cause}${noBody}。${advice}\n原始信息：${clipRaw(text)}`;
}

/** One model's part in a failure that the fallback model could not rescue. */
export interface ModelFailureReport {
	/** "provider/model". */
	model: string;
	/** Raw error text of that model's last failed request. */
	error: string;
	/** Automatic retries spent on that model before giving up. */
	retries: number;
}

/** The final error after both the main model and the fallback model failed, naming each one's cause. */
export function explainFallbackFailure(primary: ModelFailureReport, fallback: ModelFailureReport): string {
	const part = (role: string, report: ModelFailureReport) => {
		const tries = report.retries > 0 ? `（自动重试 ${report.retries} 次后仍失败）` : "";
		return `${role} ${report.model}${tries}：${explainProviderError(report.error).slice(EXPLAINED_PREFIX.length)}`;
	};
	return `${EXPLAINED_PREFIX}主模型和备用模型都失败了，任务已停止。\n${part("· 主模型", primary)}\n${part("· 备用模型", fallback)}`;
}

/** The final error when the main model failed and its fallback could not be started at all. */
export function explainUnavailableFallback(primary: ModelFailureReport, fallbackModel: string, reason: string): string {
	const tries = primary.retries > 0 ? `（自动重试 ${primary.retries} 次后仍失败）` : "";
	return `${EXPLAINED_PREFIX}主模型 ${primary.model}${tries}：${explainProviderError(primary.error).slice(EXPLAINED_PREFIX.length)}\n备用模型 ${fallbackModel} 无法接管：${reason}`;
}
