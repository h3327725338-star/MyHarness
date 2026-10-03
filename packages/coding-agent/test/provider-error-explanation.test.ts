import { describe, expect, it } from "vitest";
import {
	explainFallbackFailure,
	explainProviderError,
	explainUnavailableFallback,
} from "../src/providers/recovery/error-explanation.ts";

describe("explainProviderError", () => {
	it("names the cause of a bodiless gateway status instead of showing the bare code", () => {
		const text = explainProviderError("520 status code (no body)");
		expect(text).toMatch(/^模型请求失败：/);
		expect(text).toContain("网关与后端服务器之间连接异常（HTTP 520）");
		expect(text).toContain("没有返回任何错误说明");
		expect(text).toContain("自动重试");
		expect(text.endsWith("原始信息：520 status code (no body)")).toBe(true);
	});

	it.each([
		["521 status code (no body)", "连不上后端服务器（HTTP 521）"],
		["522 status code (no body)", "连接后端服务器超时（HTTP 522）"],
		["523 status code (no body)", "找不到可用的后端服务器（HTTP 523）"],
		["524 status code (no body)", "后端处理请求超时"],
		["525 status code (no body)", "SSL 握手失败（HTTP 525）"],
		["502 Bad Gateway", "HTTP 502"],
		["503 Service Unavailable", "暂时不可用"],
		["504 Gateway Timeout", "响应超时（HTTP 504）"],
		["500 Internal Server Error", "模型服务内部出错（HTTP 500）"],
		["529 overloaded_error", "负载过高"],
		["429 Too Many Requests", "限流"],
		["429 insufficient_quota: You exceeded your current quota", "额度或余额不足"],
		["401 Unauthorized", "认证失败"],
		['403 {"error":"forbidden"}', "拒绝访问"],
		["404 model_not_found: The model `gpt-x` does not exist", "找不到请求的模型"],
		["prompt is too long: 250000 tokens > 200000 maximum", "上下文长度上限"],
		["read ECONNRESET", "网络连接中途断开"],
		["Connection error.", "网络连接中途断开"],
		["getaddrinfo ENOTFOUND api.example.com", "域名"],
		["connect ECONNREFUSED 127.0.0.1:8080", "拒绝了连接"],
		["Request timed out.", "网络请求超时"],
		["Anthropic stream ended before message_stop", "流式响应在完成前被中断"],
		["400 invalid_request_error: tools is not supported", "请求被模型服务拒绝（HTTP 400）"],
		["something nobody has seen before", "无法识别的错误"],
	])("explains %s", (raw, cause) => {
		const text = explainProviderError(raw);
		expect(text).toMatch(/^模型请求失败：/);
		expect(text).toContain(cause);
		expect(text).toContain(`原始信息：${raw}`);
	});

	it("explains a missing error text and never explains twice", () => {
		expect(explainProviderError(undefined)).toContain("没有提供任何错误信息");
		const once = explainProviderError("520 status code (no body)");
		expect(explainProviderError(once)).toBe(once);
	});

	it("keeps long provider bodies short", () => {
		const text = explainProviderError(`500 ${"x".repeat(5_000)}`);
		expect(text.length).toBeLessThan(600);
	});
});

describe("fallback failure explanations", () => {
	it("names the cause on each model", () => {
		const text = explainFallbackFailure(
			{ model: "main/a", error: "520 status code (no body)", retries: 3 },
			{ model: "backup/b", error: "401 Unauthorized", retries: 0 },
		);
		expect(text).toContain("主模型和备用模型都失败了");
		expect(text).toContain("主模型 main/a（自动重试 3 次后仍失败）：模型服务提供商的网关");
		expect(text).toContain("备用模型 backup/b：认证失败");
		expect(text.match(/模型请求失败：/g)).toHaveLength(1);
	});

	it("says why the fallback could not take over", () => {
		const text = explainUnavailableFallback(
			{ model: "main/a", error: "503 Service Unavailable", retries: 2 },
			"backup/b",
			"backup 没有可用的 API Key",
		);
		expect(text).toContain("主模型 main/a（自动重试 2 次后仍失败）");
		expect(text).toContain("备用模型 backup/b 无法接管：backup 没有可用的 API Key");
	});
});
