/**
 * W23 — HTML 导出步骤 3：数据投影（会话 JSONL → 前端用的数据）与 wire 补字段对账测试。
 *
 * 验收目标：
 * (a) 用合成会话跑投影，断言各类内容（用户、助手、思考、工具、变更、压缩、分支、统计等）都在；
 * (b) "已知丢失项清单"测试：把 W20 loss-probe 做成断言——补过字段后不再丢失的项断言在，
 *     仍丢失/被截断的项列成清单常量 KNOWN_LOST_ITEMS 并断言清单固定；
 * (c) 路由表覆盖：前端启动会 GET 的路径全部在表里，未覆盖 GET 回 {}，非 GET 回 405；
 * (d) 断言投影结果里的 rawJsonl 字节数与输入文件一致。
 *
 * 不依赖 data/ 目录：测试夹具自建于临时目录中。
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectSession } from "../src/exports/html/replay/project.ts";
import {
	buildRoutes,
	firstUserText,
	handleRouteRequest,
	lastTs,
	lookupRoute,
	modelsFromProjection,
} from "../src/exports/html/replay/routes.ts";
import { entriesToWire, sanitizeDetails } from "../src/modes/web/wire.ts";
import { SessionManager } from "../src/session/manager/index.ts";

/**
 * W20 探针经实测确认在 wire 投影中仍丢失或被截断的项（固定清单常量）。
 * 将来若有人在未补字段的前提下改动 wire 导致多丢或少处理，测试就会失败。
 */
const KNOWN_LOST_ITEMS = [
	"thinkingSignature",
	"toolCall thoughtSignature",
	"custom: web-run-changes 的 totalAdded/totalRemoved",
	"custom: run-changes 的 patch (逐文件 diff，不进 wire items，由 routes 摊平)",
	"usage.reported / cacheReported",
	"usage.cacheWrite1h",
	"diagnostics",
	"responseId / api / requestDurationMs",
	"分支结构（旁支/未并回的叶子不在 wire items，靠 rawJsonl 兜底）",
] as const;

/**
 * W23 在 wire.ts 中补齐、已不再丢失的 5 类项。
 */
const REPAIRED_ITEMS_IN_W23 = [
	"compaction 的 usage / usageSource / details / firstKeptEntryId",
	"branch_summary 的 usage / details",
	"custom: 其它 customType (naming 进度等)",
	"label 标签条目",
	"逐条 timing (message timing 透传到 wire item)",
] as const;

// 1x1 PNG 数据
const SAMPLE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function createSyntheticLines(): string[] {
	const t0 = 1791680400000;
	const iso = (ms: number) => new Date(t0 + ms).toISOString();

	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "synthetic-project-session",
			timestamp: iso(0),
			cwd: "C:/test/synthetic-workspace",
			mode: "coding",
			workspaceId: "synthetic-workspace-id",
		}),
		JSON.stringify({
			type: "session_info",
			id: "info-01",
			parentId: null,
			timestamp: iso(1),
			name: "合成对账测试对话",
		}),
		JSON.stringify({
			type: "model_change",
			id: "model_change-01",
			parentId: "info-01",
			timestamp: iso(2),
			provider: "test-provider",
			modelId: "test-model-pro",
		}),
		JSON.stringify({
			type: "thinking_level_change",
			id: "thinking_level_change-02",
			parentId: "model_change-01",
			timestamp: iso(3),
			thinkingLevel: "high",
		}),
		JSON.stringify({
			id: "message-01",
			parentId: "thinking_level_change-02",
			timestamp: iso(4),
			type: "message",
			message: {
				role: "user",
				content: [
					{ type: "text", text: '请解释代码中的问题。<attachment path="C:/test/shot.png" />' },
					{ type: "image", mimeType: "image/png", data: SAMPLE_PNG },
				],
				timestamp: t0 + 4,
			},
		}),
		JSON.stringify({
			id: "message-02",
			parentId: "message-01",
			timestamp: iso(5),
			type: "message",
			timing: {
				providerRequestMs: 1200,
				requestMs: 1250,
				firstOutputMs: 300,
				generationMs: 950,
				toolMs: 100,
			},
			message: {
				role: "assistant",
				api: "anthropic-messages",
				provider: "test-provider",
				model: "test-model-pro",
				responseId: "resp_001",
				requestDurationMs: 1200,
				stopReason: "toolUse",
				timestamp: t0 + 5,
				usage: {
					input: 1500,
					output: 400,
					cacheRead: 50000,
					cacheWrite: 2000,
					cacheWrite1h: 500,
					reasoning: 150,
					totalTokens: 53900,
					reported: { input: true, output: true, cacheRead: true, cacheWrite: true },
					cacheReported: true,
					totalReported: true,
					cost: { input: 0.004, output: 0.006, cacheRead: 0.005, cacheWrite: 0.002, total: 0.017 },
				},
				diagnostics: [{ kind: "retry", message: "first attempt 503, retry ok" }],
				content: [
					{
						type: "thinking",
						thinking: "首先分析用户提问并检查文件代码。",
						redacted: false,
						thinkingSignature: "sig_think_abc",
					},
					{
						type: "text",
						text: "分析结论如下：\n\n| 项目 | 值 |\n| --- | --- |\n| 状态 | 正常 |\n\n```ts\nexport const x = 42;\n```",
					},
					{
						type: "toolCall",
						id: "call-read-01",
						name: "read",
						arguments: { path: "C:/test/file.ts", offset: 1, limit: 100 },
						thoughtSignature: "sig_tool_read",
					},
				],
			},
		}),
		JSON.stringify({
			id: "message-03",
			parentId: "message-02",
			timestamp: iso(6),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-read-01",
				toolName: "read",
				isError: false,
				timestamp: t0 + 6,
				content: [{ type: "text", text: Array.from({ length: 60 }, (_, i) => `line ${i + 1}: code`).join("\n") }],
				details: { durationMs: 45, linesRead: 60 },
			},
		}),
		JSON.stringify({
			id: "message-04",
			parentId: "message-03",
			timestamp: iso(7),
			type: "message",
			message: {
				role: "bashExecution",
				command: "git status",
				output: "On branch main\nnothing to commit",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timedOut: true,
				fullOutputPath: "C:/test/artifacts/bash-output.txt",
				excludeFromContext: true,
				timestamp: t0 + 7,
			},
		}),
		JSON.stringify({
			id: "compaction-01",
			parentId: "message-04",
			timestamp: iso(8),
			type: "compaction",
			summary: "历史对话压缩摘要：定位到代码错误并已修复",
			firstKeptEntryId: "message-01",
			tokensBefore: 120000,
			usageSource: { provider: "test-provider", model: "test-model-pro", currency: "USD" },
			usage: {
				input: 3000,
				output: 200,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3200,
				cost: { input: 0.01, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.013 },
			},
			details: { trigger: "manual", keptEntries: 5 },
		}),
		JSON.stringify({
			id: "branch_summary-01",
			parentId: "compaction-01",
			timestamp: iso(9),
			type: "branch_summary",
			fromId: "info-01",
			summary: "分支合并摘要：并入主干修复",
			usage: {
				input: 1000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1100,
				cost: { input: 0.003, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.004 },
			},
			details: { branchSource: "feature-fix" },
		}),
		JSON.stringify({
			id: "custom-git-01",
			parentId: "branch_summary-01",
			timestamp: iso(10),
			type: "custom",
			customType: "web-git-status",
			data: { action: "commit", hash: "a1b2c3d4", message: "fix: test", at: iso(10) },
		}),
		JSON.stringify({
			id: "custom-changes-01",
			parentId: "custom-git-01",
			timestamp: iso(11),
			type: "custom",
			customType: "web-run-changes",
			data: {
				runId: 1,
				files: [{ path: "src/file.ts", added: 5, removed: 2, patch: "@@ -1,2 +1,5 @@\n-old\n+new" }],
				totalAdded: 5,
				totalRemoved: 2,
			},
		}),
		JSON.stringify({
			id: "custom-naming-01",
			parentId: "custom-changes-01",
			timestamp: iso(12),
			type: "custom",
			customType: "conversation-naming-progress",
			data: { state: "done", title: "测试标题命名" },
		}),
		JSON.stringify({
			id: "custom_msg-01",
			parentId: "custom-naming-01",
			timestamp: iso(13),
			type: "custom_message",
			customType: "permission-notice",
			content: "权限已确认：写入允许",
			display: true,
			details: { approved: true },
		}),
		JSON.stringify({
			id: "label-01",
			parentId: "custom_msg-01",
			timestamp: iso(14),
			type: "label",
			targetId: "message-02",
			label: "关键步骤标记",
		}),
		JSON.stringify({
			id: "message-05",
			parentId: "label-01",
			timestamp: iso(15),
			type: "message",
			message: {
				role: "assistant",
				api: "anthropic-messages",
				provider: "test-provider",
				model: "test-model-pro",
				stopReason: "stop",
				timestamp: t0 + 15,
				usage: {
					input: 200,
					output: 300,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 500,
					cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
				},
				content: [{ type: "text", text: "已完全排查完毕，所有改动已生效并经过验证。" }],
			},
		}),
		JSON.stringify({
			id: "message-06",
			parentId: "message-05",
			timestamp: iso(16),
			type: "message",
			message: {
				role: "assistant",
				api: "anthropic-messages",
				provider: "test-provider",
				model: "test-model-pro",
				stopReason: "aborted",
				errorMessage: "Request interrupted by user",
				timestamp: t0 + 16,
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				content: [{ type: "thinking", thinking: "被提前中止的思考过程", redacted: true }],
			},
		}),
	];
}

describe("W23 数据投影与 wire 补字段对账", () => {
	let tempDir: string;
	let sessionFilePath: string;
	let rawFileContent: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "export-replay-project-test-"));
		const lines = createSyntheticLines();
		rawFileContent = `${lines.join("\n")}\n`;
		sessionFilePath = join(tempDir, "synthetic-session.jsonl");
		writeFileSync(sessionFilePath, rawFileContent, "utf8");
	});

	afterAll(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Best effort cleanup
		}
	});

	describe("(a) 合成会话跑投影，断言各类内容完整在场", () => {
		it("投影结果包含完整的 wire items、snapshot、stats、meta、rawJsonl", () => {
			const projection = projectSession({
				file: sessionFilePath,
				prefs: { theme: "light", lang: "zh-CN" },
			});

			// 基本结构
			expect(projection).toHaveProperty("items");
			expect(projection).toHaveProperty("snapshot");
			expect(projection).toHaveProperty("stats");
			expect(projection).toHaveProperty("meta");
			expect(projection).toHaveProperty("rawJsonl");
			expect(projection).toHaveProperty("entryTypes");

			// wire items 包含各类 kind
			const kinds = new Set(projection.items.map((i) => i.kind));
			expect(kinds.has("user")).toBe(true);
			expect(kinds.has("assistant")).toBe(true);
			expect(kinds.has("toolResult")).toBe(true);
			expect(kinds.has("bash")).toBe(true);
			expect(kinds.has("compaction")).toBe(true);
			expect(kinds.has("branchSummary")).toBe(true);
			expect(kinds.has("gitStatus")).toBe(true);
			expect(kinds.has("runChanges")).toBe(true);
			expect(kinds.has("custom")).toBe(true);
			expect(kinds.has("label")).toBe(true);

			// 用户内容与附件图片
			const userItem = projection.items.find((i) => i.kind === "user");
			expect(userItem).toBeDefined();
			expect(userItem?.text).toContain("请解释代码中的问题");
			expect(userItem?.images.length).toBe(1);
			expect(userItem?.images[0].data).toBe(SAMPLE_PNG);

			// 助手正文、思考块（含 redacted）、工具调用参数
			const assistantItems = projection.items.filter((i) => i.kind === "assistant");
			expect(assistantItems.length).toBeGreaterThanOrEqual(2);

			const normalAssistant = assistantItems.find((a) => a.stopReason === "toolUse");
			expect(normalAssistant).toBeDefined();
			expect(normalAssistant?.blocks.some((b) => b.type === "thinking" && b.text.includes("首先分析"))).toBe(true);
			expect(normalAssistant?.blocks.some((b) => b.type === "text" && b.text.includes("分析结论如下"))).toBe(true);
			const toolCallBlock = normalAssistant?.blocks.find((b) => b.type === "toolCall");
			expect(toolCallBlock).toBeDefined();
			expect(toolCallBlock?.name).toBe("read");
			expect(toolCallBlock?.args).toEqual({ path: "C:/test/file.ts", offset: 1, limit: 100 });

			const abortedAssistant = assistantItems.find((a) => a.stopReason === "aborted");
			expect(abortedAssistant).toBeDefined();
			const redactedBlock = abortedAssistant?.blocks.find((b) => b.type === "thinking");
			expect(redactedBlock).toBeDefined();
			expect(redactedBlock?.redacted).toBe(true);

			// 工具结果
			const toolResultItem = projection.items.find((i) => i.kind === "toolResult");
			expect(toolResultItem).toBeDefined();
			expect(toolResultItem?.toolName).toBe("read");
			expect(toolResultItem?.text).toContain("line 1: code");
			expect(toolResultItem?.details).toEqual({ durationMs: 45, linesRead: 60 });

			// bashExecution
			const bashItem = projection.items.find((i) => i.kind === "bash");
			expect(bashItem).toBeDefined();
			expect(bashItem?.command).toBe("git status");
			expect(bashItem?.output).toContain("On branch main");
			expect(bashItem?.fullOutputPath).toBe("C:/test/artifacts/bash-output.txt");
			expect(bashItem?.timedOut).toBe(true);
			expect(bashItem?.excludeFromContext).toBe(true);

			// 快照字段
			const snap = projection.snapshot;
			expect(snap.mode).toBe("coding");
			expect(snap.slot).toBe("export");
			expect(snap.cwd).toBe(projection.meta.cwd);
			expect(snap.workspace).toEqual({
				id: "synthetic-workspace-id",
				name: null,
				rootPath: projection.meta.cwd,
			});
			expect((snap.session as { name?: string })?.name).toBe("合成对账测试对话");
			expect((snap.model as { provider?: string; id?: string })?.provider).toBe("test-provider");
			expect((snap.model as { id?: string })?.id).toBe("test-model-pro");
			expect((snap.thinking as { level?: string })?.level).toBe("high");
			expect((snap.run as { state?: string })?.state).toBe("completed");

			// 统计 stats
			expect(projection.stats).toBeDefined();
			expect(projection.stats.tokens.total).toBeGreaterThan(0);
			expect(projection.stats.cost).toBeGreaterThan(0);

			// 元信息 meta
			expect(projection.meta.name).toBe("合成对账测试对话");
			expect(projection.meta.cwd.replace(/\\/g, "/")).toBe("C:/test/synthetic-workspace");
			expect(projection.meta.mode).toBe("coding");
			expect(projection.meta.file).toBe(sessionFilePath);
			expect(projection.meta.entryCount).toBeGreaterThanOrEqual(16);
		});

		it("支持传入已有 SessionManager 实例进行投影", () => {
			const manager = SessionManager.open(sessionFilePath);
			const projection = projectSession({
				sessionManager: manager,
			});
			expect(projection.items.length).toBeGreaterThan(0);
			expect(projection.meta.name).toBe("合成对账测试对话");
			expect(projection.leafId).toBe(manager.getLeafId());
		});
	});

	describe("(b) 已知丢失项清单测试与 W23 补字段断言", () => {
		it("补齐后 5 类字段已不再丢失", () => {
			expect(REPAIRED_ITEMS_IN_W23).toHaveLength(5);
			const projection = projectSession({ file: sessionFilePath });
			const wireJson = JSON.stringify(projection.items);

			// 1. compaction 的 usage / usageSource / details / firstKeptEntryId
			const comp = projection.items.find((i) => i.kind === "compaction");
			expect(comp).toBeDefined();
			expect(comp?.summary).toContain("历史对话压缩摘要");
			expect(comp?.tokensBefore).toBe(120000);
			expect(comp?.firstKeptEntryId).toBe("message-01");
			expect(comp?.usageSource).toEqual({
				provider: "test-provider",
				model: "test-model-pro",
				currency: "USD",
			});
			expect(comp?.usage).toBeDefined();
			expect(comp?.usage?.totalTokens).toBe(3200);
			expect(comp?.usage?.cost).toBe(0.013);
			expect(comp?.details).toEqual({ trigger: "manual", keptEntries: 5 });

			// 2. branch_summary 的 usage / details
			const branch = projection.items.find((i) => i.kind === "branchSummary");
			expect(branch).toBeDefined();
			expect(branch?.summary).toContain("分支合并摘要");
			expect(branch?.fromId).toBe("info-01");
			expect(branch?.usage).toBeDefined();
			expect(branch?.usage?.totalTokens).toBe(1100);
			expect(branch?.usage?.cost).toBe(0.004);
			expect(branch?.details).toEqual({ branchSource: "feature-fix" });

			// 3. custom: 其它 customType (naming 进度等) 兜底保留
			const naming = projection.items.find(
				(i) => i.kind === "custom" && i.customType === "conversation-naming-progress",
			);
			expect(naming).toBeDefined();
			if (naming && naming.kind === "custom") {
				expect(naming.customType).toBe("conversation-naming-progress");
				expect(naming.details).toEqual({ state: "done", title: "测试标题命名" });
			}
			expect(wireJson).toContain("conversation-naming-progress");

			// 4. label 标签条目保留
			const labelItem = projection.items.find((i) => i.kind === "label");
			expect(labelItem).toBeDefined();
			if (labelItem && labelItem.kind === "label") {
				expect(labelItem.targetId).toBe("message-02");
				expect(labelItem.label).toBe("关键步骤标记");
			}
			expect(wireJson).toContain("关键步骤标记");

			// 5. 逐条 timing 透传到 wire item
			const timedAssistant = projection.items.find((i) => i.kind === "assistant" && i.timing !== undefined);
			expect(timedAssistant).toBeDefined();
			if (timedAssistant && timedAssistant.kind === "assistant") {
				expect(timedAssistant.timing).toEqual({
					providerRequestMs: 1200,
					requestMs: 1250,
					firstOutputMs: 300,
					generationMs: 950,
					toolMs: 100,
				});
			}
		});

		it("仍丢失/被截断项固定在 KNOWN_LOST_ITEMS 清单常量中，断言清单不变", () => {
			const expectedList = [
				"thinkingSignature",
				"toolCall thoughtSignature",
				"custom: web-run-changes 的 totalAdded/totalRemoved",
				"custom: run-changes 的 patch (逐文件 diff，不进 wire items，由 routes 摊平)",
				"usage.reported / cacheReported",
				"usage.cacheWrite1h",
				"diagnostics",
				"responseId / api / requestDurationMs",
				"分支结构（旁支/未并回的叶子不在 wire items，靠 rawJsonl 兜底）",
			];

			expect(KNOWN_LOST_ITEMS).toEqual(expectedList);

			const projection = projectSession({ file: sessionFilePath });
			const wireJson = JSON.stringify(projection.items);

			// 逐项确认它们确实不在 wire items 结构内（不静默冒充）
			expect(wireJson).not.toContain("sig_think_abc"); // thinkingSignature
			expect(wireJson).not.toContain("sig_tool_read"); // toolCall thoughtSignature
			expect(wireJson).not.toContain('"totalAdded":5'); // web-run-changes totalAdded
			expect(wireJson).not.toContain("@@ -1,2 +1,5 @@"); // patch 在 wire items 外部（由 routes card-diff 承载）
			expect(wireJson).not.toContain("cacheWrite1h"); // wireUsage 不含 cacheWrite1h
			expect(wireJson).not.toContain("first attempt 503"); // diagnostics 不进 wire
			expect(wireJson).not.toContain("resp_001"); // responseId 不进 wire
		});

		it("detailsCharLimit 可选参数生效：超限截断、调大放开", () => {
			const bigDetails = { largeData: "X".repeat(500_000) };
			// 默认 400KB 上限截断
			const defaultSanitized = sanitizeDetails(bigDetails) as { truncatedDetails?: boolean; originalChars?: number };
			expect(defaultSanitized.truncatedDetails).toBe(true);
			expect(defaultSanitized.originalChars).toBeGreaterThan(500_000);

			// 自定义 1MB 上限不截断
			const largerSanitized = sanitizeDetails(bigDetails, 1_000_000);
			expect(largerSanitized).toEqual(bigDetails);

			// entriesToWire 传递 options.detailsCharLimit
			const entryWithBigDetails = {
				id: "msg-big-01",
				parentId: null,
				timestamp: new Date().toISOString(),
				type: "message" as const,
				message: {
					role: "toolResult" as const,
					toolCallId: "call-big-01",
					toolName: "big_tool",
					isError: false,
					timestamp: Date.now(),
					content: [{ type: "text" as const, text: "ok" }],
					details: bigDetails,
				},
			};

			const wireDefault = entriesToWire([entryWithBigDetails]);
			const defItem = wireDefault[0];
			expect(defItem?.kind).toBe("toolResult");
			if (defItem && defItem.kind === "toolResult") {
				expect((defItem.details as { truncatedDetails?: boolean })?.truncatedDetails).toBe(true);
			}

			const wireExpanded = entriesToWire([entryWithBigDetails], { detailsCharLimit: 1_000_000 });
			const expItem = wireExpanded[0];
			expect(expItem?.kind).toBe("toolResult");
			if (expItem && expItem.kind === "toolResult") {
				expect(expItem.details).toEqual(bigDetails);
			}
		});
	});

	describe("(c) 路由表覆盖与请求响应断言", () => {
		it("前端启动 GET 的路径全部在路由表里", () => {
			const projection = projectSession({ file: sessionFilePath });
			const { routes } = buildRoutes({
				projection,
				prefs: { lang: "zh-CN", theme: "light" },
			});

			const requiredPaths = [
				"/api/boot",
				"/api/state",
				"/api/modes/state",
				"/api/transcript",
				"/api/slots",
				"/api/workspaces?mode=coding",
				"/api/workspaces?mode=general",
				"/api/workspaces",
				`/api/workspaces/sessions?path=${encodeURIComponent(String(projection.snapshot.cwd))}&mode=coding`,
				"/api/workspaces/sessions",
				"/api/sessions/unbound?mode=coding",
				"/api/sessions/unbound?mode=general",
				"/api/sessions/unbound",
				"/api/sessions/archived?mode=coding",
				"/api/sessions/archived?mode=general",
				"/api/sessions/archived",
				"/api/sessions/tree",
				"/api/git/status",
				"/api/settings",
				"/api/providers",
				"/api/sessions/stats",
				"/api/models",
				"/api/resources",
				"/api/changes/card-diff",
			];

			for (const path of requiredPaths) {
				const res = handleRouteRequest(routes, path, "GET");
				expect(res.ok).toBe(true);
				expect(res.status).toBe(200);
				expect(res.data).toBeDefined();
			}

			// 变更卡片中的具体文件 diff 路由已摊平
			const diffRouteKey = Object.keys(routes).find((k) => k.startsWith("/api/changes/card-diff?"));
			expect(diffRouteKey).toBeDefined();
			const diffRes = handleRouteRequest(routes, diffRouteKey!, "GET");
			expect(diffRes.ok).toBe(true);
			expect((diffRes.data as { patch?: string })?.patch).toContain("@@ -1,2 +1,5 @@");
		});

		it("未覆盖的 GET 请求默认返回 {} 不报错", () => {
			const projection = projectSession({ file: sessionFilePath });
			const { routes } = buildRoutes({ projection });

			const res = handleRouteRequest(routes, "/api/uncovered/nonexistent/path", "GET");
			expect(res.ok).toBe(true);
			expect(res.status).toBe(200);
			expect(res.data).toEqual({});
		});

		it("非 GET 写请求一律返回 405 + { error: 'Read only' }", () => {
			const projection = projectSession({ file: sessionFilePath });
			const { routes } = buildRoutes({ projection });

			const postRes = handleRouteRequest(routes, "/api/modes/open", "POST");
			expect(postRes.status).toBe(405);
			expect(postRes.ok).toBe(false);
			expect(postRes.data).toEqual({ error: "Read only" });

			const putRes = handleRouteRequest(routes, "/api/settings", "PUT");
			expect(putRes.status).toBe(405);
			expect(putRes.data).toEqual({ error: "Read only" });

			const deleteRes = handleRouteRequest(routes, "/api/sessions", "DELETE");
			expect(deleteRes.status).toBe(405);
			expect(deleteRes.data).toEqual({ error: "Read only" });
		});

		it("models 路由正确聚合会话模型与快照当前模型", () => {
			const projection = projectSession({ file: sessionFilePath });
			const models = modelsFromProjection(projection) as {
				current: { provider: string; id: string } | null;
				providers: Array<{ id: string; models: Array<{ id: string }> }>;
			};

			expect(models.current).toEqual({ provider: "test-provider", id: "test-model-pro" });
			expect(models.providers.length).toBeGreaterThanOrEqual(1);
			expect(models.providers[0].models.some((m) => m.id === "test-model-pro")).toBe(true);
		});
	});

	describe("(d) 原始 rawJsonl 字节数与输入文件严格一致", () => {
		it("rawJsonl 字节数与文件 statSync 大小逐字节一致", () => {
			const projection = projectSession({ file: sessionFilePath });
			const expectedBytes = statSync(sessionFilePath).size;
			const actualBytes = Buffer.byteLength(projection.rawJsonl, "utf8");

			expect(actualBytes).toBe(expectedBytes);
			expect(projection.rawJsonl).toBe(rawFileContent);
		});
	});

	describe("辅助工具函数单测", () => {
		it("firstUserText 提取首条用户消息前 200 字符", () => {
			const items = [{ kind: "user" as const, ts: 100, text: "  hello   world  \n  test  ", images: [] }];
			expect(firstUserText(items)).toBe("hello world test");
		});

		it("lastTs 提取最后一条带 ts 的 item 时间戳", () => {
			const items = [
				{ kind: "user" as const, ts: 1000, text: "a", images: [] },
				{ kind: "assistant" as const, ts: 2000, blocks: [], stopReason: "stop", provider: "p", model: "m" },
			];
			expect(lastTs(items)).toBe(2000);
		});

		it("lookupRoute 在精确匹配与参数匹配上的正确性", () => {
			const routes = {
				"/api/test": { ok: 1 },
				"/api/query?a=1&b=2": { ok: 2 },
			};
			expect(lookupRoute(routes, "/api/test")).toEqual({ ok: 1 });
			expect(lookupRoute(routes, "/api/query?a=1&b=2")).toEqual({ ok: 2 });
			expect(lookupRoute(routes, "/api/nonexistent")).toBeUndefined();
		});
	});
});
