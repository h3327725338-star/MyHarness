import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertNoExternalReferences, buildReplayHtml } from "../src/exports/html/replay/build.ts";
import { RUN_CHANGES_ENTRY } from "../src/modes/web/wire.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { launchChromium } from "../src/tools/web-search/browser/chromium.ts";
import { detectInstalledBrowsers } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
const chromeCandidate = installed.find((b) => b.kind === "chrome") ?? installed.find((b) => b.kind === "edge");

const shouldRun = process.env.MYHARNESS_TARGETED_BROWSER_E2E === "1" && !!chromeCandidate;

class TestReplayBrowser {
	kind: string;
	executable: string;
	profileDir: string;
	child?: any;
	bridge?: any;
	targetId?: string;
	sessionId?: string;
	consoleLogs: Array<{ type: string; text: string }> = [];
	pageErrors: Array<{ text: string }> = [];
	networkRequests: Array<{ url: string; event: string; error?: string }> = [];

	constructor(kind: string, executable: string, profileDir: string) {
		this.kind = kind;
		this.executable = executable;
		this.profileDir = profileDir;
	}

	async start() {
		mkdirSync(this.profileDir, { recursive: true });
		const launch = launchChromium({
			executable: this.executable,
			profileDir: this.profileDir,
			headless: true,
			brand: this.kind === "edge" ? "Microsoft Edge" : "Google Chrome",
		});
		this.child = launch.child;
		this.bridge = launch.bridge;
		await (launch as any).ready();

		const origOnEvent = this.bridge.onEvent ? this.bridge.onEvent.bind(this.bridge) : () => {};
		this.bridge.onEvent = (message: any) => {
			const method = message.method;
			const params = message.params ?? {};
			if (method === "Runtime.consoleAPICalled") {
				const text = (params.args ?? [])
					.map((a: any) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type ?? "")))
					.join(" ");
				if (params.type === "error" || params.type === "warning") {
					this.consoleLogs.push({ type: params.type, text });
				}
			} else if (method === "Runtime.exceptionThrown") {
				const d = params.exceptionDetails ?? {};
				this.pageErrors.push({ text: d.exception?.description ?? d.text ?? "unknown" });
			} else if (method === "Log.entryAdded") {
				const entry = params.entry ?? {};
				if (entry.level === "error" || entry.level === "warning") {
					this.consoleLogs.push({
						type: `log:${entry.level}`,
						text: `${entry.source ?? ""} ${entry.text ?? ""}`.trim(),
					});
				}
			} else if (method === "Network.requestWillBeSent") {
				const url = params.request?.url ?? "";
				this.networkRequests.push({ url, event: method });
			} else if (method === "Network.loadingFailed") {
				const error = params.errorText ?? "";
				if (error !== "net::ERR_ABORTED") {
					this.networkRequests.push({ url: params.url ?? "", event: method, error });
				}
			}
			origOnEvent(message);
		};
	}

	async send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
		return this.bridge.send(method, params, sessionId);
	}

	async open(url: string, { readySelector = "", timeoutMs = 60_000, settleMs = 2000 } = {}) {
		const created = await this.send("Target.createTarget", { url: "about:blank" });
		this.targetId = String(created.targetId);
		const attached = await this.send("Target.attachToTarget", { targetId: this.targetId, flatten: true });
		this.sessionId = String(attached.sessionId);

		await this.send("Page.enable", {}, this.sessionId);
		await this.send("Network.enable", {}, this.sessionId);
		await this.send("Runtime.enable", {}, this.sessionId);
		await this.send("Log.enable", {}, this.sessionId);

		// 断网测试
		await this.send(
			"Network.emulateNetworkConditions",
			{ offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
			this.sessionId,
		);

		await this.send("Page.navigate", { url }, this.sessionId);

		const deadline = Date.now() + timeoutMs;
		let ready = false;
		while (Date.now() < deadline) {
			const probe: any = await this.evaluate(
				`(function(){try{return {state:document.readyState,ready:${readySelector ? `!!document.querySelector(${JSON.stringify(readySelector)})` : "true"}}}catch(e){return {state:"error",ready:false}}})()`,
			);
			if (probe?.ready) {
				ready = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 200));
		}

		const settleStart = Date.now();
		while (Date.now() - settleStart < settleMs) {
			await new Promise((r) => setTimeout(r, 100));
		}
		return { ready, url };
	}

	async evaluate(expression: string): Promise<any> {
		const reply = await this.send(
			"Runtime.evaluate",
			{ expression, returnByValue: true, awaitPromise: true },
			this.sessionId,
		);
		if (reply.exceptionDetails) {
			throw new Error(`页面报错: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
		}
		return reply.result?.value;
	}

	async close() {
		try {
			await this.bridge?.quit();
		} catch {}
		this.bridge?.close?.();
		if (this.child?.pid) {
			try {
				process.kill(this.child.pid);
			} catch {}
		}
	}

	summary() {
		const failed = this.networkRequests.filter((n) => n.event === "Network.loadingFailed");
		const nonFile = this.networkRequests.filter(
			(n) =>
				n.event === "Network.requestWillBeSent" &&
				!n.url.startsWith("file://") &&
				!n.url.startsWith("data:") &&
				!n.url.startsWith("about:"),
		);
		return {
			consoleErrors: this.consoleLogs.filter((c) => c.type === "error" || c.type === "log:error"),
			pageErrors: this.pageErrors,
			failedRequests: failed,
			nonFileRequests: nonFile,
		};
	}
}

describe.runIf(shouldRun)("web-export-replay-completeness-browser", () => {
	let tempDir: string;
	let sessionFilePath: string;
	let exportHtmlPath: string;
	let browser: TestReplayBrowser;
	let rawJsonlOnDisk: string;

	const dummy1x1Png =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

	beforeAll(async () => {
		tempDir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "w25b-replay-completeness-"));
		const profileDir = join(tempDir, "chrome-profile");
		exportHtmlPath = join(tempDir, "replay-export.html");

		const sm = SessionManager.create(tempDir, undefined, undefined, {
			dataRoot: join(tempDir, "data"),
			agentDir: tempDir,
		});
		sm.appendSessionInfo("完整性信息对账会话 W25b");

		// 1. 添加 62 轮普通问答以触发「显示更早的消息」按钮 (transcript.js limit=60)
		for (let i = 1; i <= 62; i++) {
			sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: `早期轮次 ${i}: 用户提问` }],
				timestamp: Date.now() + i * 10,
			});
			sm.appendMessage({
				role: "assistant",
				api: "test",
				provider: "anthropic",
				model: "claude-3-5-sonnet",
				content: [{ type: "text", text: `早期轮次 ${i}: 助手简答` }],
				usage: {
					input: 20,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 30,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now() + i * 10 + 5,
			});
		}

		// 2. 压缩摘要 (compaction)
		const firstId = sm.getEntries()[0]?.id || "info-1";
		sm.appendCompaction("这是被压缩的早期对话摘要正文，包含重要上下文索引。", firstId, 45000);

		// 3. 分支摘要 (branch_summary)
		const branchLeaf = sm.getLeafId();
		sm.branchWithSummary(branchLeaf, "这是探索分支的合并摘要正文。");

		// 4. 用户消息含图片附件
		sm.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "请看附带的架构图并进行分析" },
				{ type: "image", mimeType: "image/png", data: dummy1x1Png },
			],
			timestamp: Date.now() + 2000,
		});

		// 5. 助手回复：含 Markdown 表格、代码块、Token/费用小字
		sm.appendMessage({
			role: "assistant",
			api: "test",
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			content: [
				{
					type: "text",
					text: `### 架构分析报告\n\n下面是组件对账表：\n\n| 组件 | 状态 | 覆盖度 |\n| :--- | :--- | :--- |\n| 导出外壳 | 就绪 | 100% |\n| 路由表 | 完成 | 100% |\n\n代码实现示例：\n\`\`\`typescript\nexport function verify(): boolean {\n  return true;\n}\n\`\`\`\n\n本地链接探针：[应用入口探针](src/index.ts)。`,
				},
			],
			usage: {
				input: 1250,
				output: 480,
				cacheRead: 100,
				cacheWrite: 50,
				totalTokens: 1880,
				cost: { input: 0.005, output: 0.0075, cacheRead: 0, cacheWrite: 0, total: 0.0125 },
			},
			stopReason: "stop",
			timestamp: Date.now() + 2100,
		});

		// 6. 助手思考块与工具调用（超长参数与超长结果，超长结果默认折叠）
		const longArgs = {
			pattern: "deep-search-*".repeat(30),
			options: { verbose: true, depth: 99, filter: "all".repeat(40) },
		};
		const longResult = `[SUCCESS] 找到 1200 个匹配项：\n${"result_line_item_entry_".repeat(80)}\n`.repeat(30);

		sm.appendMessage({
			role: "assistant",
			api: "test",
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			content: [
				{
					type: "thinking",
					thinking: "我需要调用工具来核查深层文件结构，分析长参数调用以及超长输出的折叠行为。",
				},
				{
					type: "toolCall",
					id: "call_deep_search_1",
					name: "search_code",
					arguments: longArgs,
				},
			],
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now() + 2200,
		});

		sm.appendMessage({
			role: "toolResult",
			toolCallId: "call_deep_search_1",
			toolName: "search_code",
			content: [{ type: "text", text: longResult }],
			isError: false,
			details: { rawLines: 1200, outputText: longResult },
			timestamp: Date.now() + 2300,
		});

		// 7. 自定义条目：web-git-status 与 custom_message
		sm.appendCustomEntry("web-git-status", {
			branch: "feature/export-completeness",
			clean: false,
			modified: ["src/index.ts", "web/js/app.js"],
		});

		sm.appendCustomMessageEntry("test-note", "自定义信息卡片：这是一条显式展示的自定义消息。", true);

		// 8. bash 命令行 (! 命令)
		sm.appendMessage({
			role: "bashExecution",
			command: "git status -s && pnpm test",
			output: "M packages/coding-agent/src/exports/html/replay/build.ts\nPASS test/export-replay.test.ts",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now() + 2400,
		});

		// 9. 变更卡片（web-run-changes，带 diff patch）
		const diffPatch = `--- a/packages/coding-agent/src/export.ts\n+++ b/packages/coding-agent/src/export.ts\n@@ -1,3 +1,4 @@\n-export const version = 1;\n+export const version = 2;\n+export const completeness = true;`;
		sm.appendCustomEntry(RUN_CHANGES_ENTRY, {
			runId: 101,
			files: [
				{
					path: "packages/coding-agent/src/export.ts",
					status: "modified",
					patch: diffPatch,
					additions: 2,
					deletions: 1,
					binary: false,
				},
			],
		});

		// 保存并获取真实磁盘 JSONL
		sessionFilePath = sm.getSessionFile()!;
		rawJsonlOnDisk = readFileSync(sessionFilePath, "utf8");

		// 导出为 HTML
		const html = await buildReplayHtml({
			sessionManager: sm,
			prefs: {
				lang: "zh-CN",
				theme: "light",
				colorTheme: "forest",
				motion: "off",
			},
			name: "完整性信息对账会话 W25b",
		});

		// 校验导出内容没有外部引用
		assertNoExternalReferences(html);
		writeFileSync(exportHtmlPath, html, "utf8");

		// 启动测试浏览器并以 file:// 打开导出页面
		browser = new TestReplayBrowser(chromeCandidate!.kind, chromeCandidate!.executable, profileDir);
		await browser.start();
		const opened = await browser.open(pathToFileURL(exportHtmlPath).href, {
			readySelector: ".transcript-inner > *",
			timeoutMs: 60_000,
			settleMs: 3000,
		});
		if (!opened.ready) {
			throw new Error("页面首屏加载超时或未渲染内容");
		}
	}, 120_000);

	afterAll(async () => {
		if (browser) {
			await browser.close();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
		}
	});

	it("打开导出页面，首屏渲染正常且具有只读标记", async () => {
		const diag = await browser.evaluate(`(function() {
			var root = document.documentElement;
			return {
				exportReadonly: root.dataset.exportReadonly,
				lang: root.lang,
				theme: root.dataset.theme,
				colorTheme: root.dataset.colorTheme,
				hasGlobal: !!window.__MYHARNESS_EXPORT__,
				splashExists: !!document.querySelector('.splash'),
				connBannerExists: !!document.querySelector('.conn-banner'),
				toasts: [].map.call(document.querySelectorAll('.toast'), function(t) { return t.innerText }),
			};
		})()`);

		expect(diag.exportReadonly).toBe("1");
		expect(diag.lang).toBe("zh-CN");
		expect(diag.theme).toBe("light");
		expect(diag.colorTheme).toBe("forest");
		expect(diag.hasGlobal).toBe(true);
		expect(diag.splashExists).toBe(false);
		expect(diag.connBannerExists).toBe(false);
		expect(diag.toasts).toHaveLength(0);
	});

	it("控制台 0 错误、无失败请求、无对 file:// 以外的请求", () => {
		const summary = browser.summary();
		expect(summary.consoleErrors).toHaveLength(0);
		expect(summary.pageErrors).toHaveLength(0);
		expect(summary.failedRequests).toHaveLength(0);
		expect(summary.nonFileRequests).toHaveLength(0);
	});

	it("内嵌原始 JSONL 与磁盘输入文件逐字节一致", async () => {
		const rawJsonlInPage = await browser.evaluate(`(function() {
			var E = window.__MYHARNESS_EXPORT__;
			return (E && E.data && E.data.rawJsonl) || null;
		})()`);

		expect(rawJsonlInPage).not.toBeNull();
		const expectedBuffer = Buffer.from(rawJsonlOnDisk, "utf8");
		const actualBuffer = Buffer.from(rawJsonlInPage, "utf8");
		expect(actualBuffer.equals(expectedBuffer)).toBe(true);
	});

	it("实测导出页上只读按钮（Changes / Files / Terminal / 新对话 / 添加工作区）置灰与禁用状态", async () => {
		const buttonStates = await browser.evaluate(`(function() {
			var findBtn = function(selector) {
				return document.querySelector(selector);
			};
			var getInfo = function(el) {
				if (!el) return null;
				var cs = window.getComputedStyle(el);
				return {
					found: true,
					tagName: el.tagName,
					disabled: !!el.disabled,
					ariaDisabled: el.getAttribute('aria-disabled'),
					dataOffline: el.getAttribute('data-export-offline'),
					classList: Array.from(el.classList),
					opacity: cs.opacity,
					pointerEvents: cs.pointerEvents,
					cursor: cs.cursor,
				};
			};

			return {
				changes: getInfo(document.querySelector('button[data-export-offline][title*="Changes"], button[data-export-offline][aria-label*="Changes"], button[data-export-offline][title*="改动"], button[data-export-offline][title*="变更"]')),
				files: getInfo(document.querySelector('button[data-export-offline][title*="Files"], button[data-export-offline][aria-label*="Files"], button[data-export-offline][title*="文件"]')),
				terminal: getInfo(document.querySelector('button[data-export-offline][title*="Terminal"], button[data-export-offline][aria-label*="Terminal"], button[data-export-offline][title*="终端"]')),
				newChat: getInfo(document.querySelector('button[data-export-offline].primary-nav, button[data-export-offline][title*="新对话"], button[data-export-offline][title*="New chat"]')),
				addWorkspace: getInfo(document.querySelector('.side-section button[data-export-offline], button[data-export-offline][title*="添加工作区"], button[data-export-offline][title*="Add workspace"]')),
			};
		})()`);

		// 记录只读按钮详细属性
		for (const [name, state] of Object.entries(buttonStates)) {
			expect(state, `按钮 ${name} 应该在页面中找到`).not.toBeNull();
			const s = state as any;
			expect(s.disabled || s.ariaDisabled === "true").toBe(true);
			expect(s.classList).toContain("export-offline");
			// CSS 定义了 html[data-export-readonly="1"] [data-export-offline] { opacity: 0.45; cursor: not-allowed; }
			expect(parseFloat(s.opacity)).toBeCloseTo(0.45, 1);
		}
	});

	it("逐类断言所有条目类型可见且内容正确，并在交互展开后呈现完整内容", async () => {
		// 1. 首屏各类元素检查
		const initialCounts = await browser.evaluate(`(function() {
			return {
				userRow: document.querySelectorAll('.user-row').length,
				userImg: document.querySelectorAll('.user-row img').length,
				finalMsg: document.querySelectorAll('.final').length,
				msgMeta: document.querySelectorAll('.msg-meta').length,
				table: document.querySelectorAll('.final table').length,
				codeBlock: document.querySelectorAll('.final pre code').length,
				thinking: document.querySelectorAll('.thinking').length,
				actionRow: document.querySelectorAll('.action-row').length,
				steps: document.querySelectorAll('.steps').length,
				changeCard: document.querySelectorAll('.change-card').length,
				customCard: document.querySelectorAll('.custom-card').length,
				bashEntry: document.querySelectorAll('.bash-entry').length,
				earlierBtn: document.querySelectorAll('.earlier').length,
			};
		})()`);

		expect(initialCounts.userRow).toBeGreaterThan(0);
		expect(initialCounts.userImg).toBeGreaterThan(0);
		expect(initialCounts.finalMsg).toBeGreaterThan(0);
		expect(initialCounts.msgMeta).toBeGreaterThan(0);
		expect(initialCounts.table).toBeGreaterThan(0);
		expect(initialCounts.codeBlock).toBeGreaterThan(0);
		expect(initialCounts.thinking).toBeGreaterThan(0);
		expect(initialCounts.actionRow).toBeGreaterThan(0);
		expect(initialCounts.changeCard).toBeGreaterThan(0);
		expect(initialCounts.customCard).toBeGreaterThan(0);
		expect(initialCounts.bashEntry).toBeGreaterThan(0);
		// 超过 60 轮，因此首屏应有「显示更早的消息」按钮
		expect(initialCounts.earlierBtn).toBeGreaterThan(0);

		// 2. 交互展开：点击「显示更早的消息」、展开工具原始结果、展开压缩/分支摘要、展开文件变更 diff
		await browser.evaluate(`(function() {
			var clicks = [];
			// 点击更早的消息直到全部展开
			var earlier = 0;
			while (document.querySelector('.earlier') && earlier < 5) {
				document.querySelector('.earlier').click();
				earlier++;
			}
			clicks.push({ action: 'earlier', count: earlier });

			// 点击展开工具步骤 -> 展现 .raw
			var actionRow = document.querySelector('.action .action-row');
			if (actionRow) {
				actionRow.click();
				clicks.push({ action: 'actionRow', clicked: true });
			}

			// 点击展开摘要标记 -> 展现 .marker-body
			var markerHeads = document.querySelectorAll('.marker-head');
			var markerCount = 0;
			markerHeads.forEach(function(mh) {
				mh.click();
				markerCount++;
			});
			clicks.push({ action: 'markerHead', count: markerCount });

			// 点击展开变更文件 -> 展现 .dl / .hunk
			var changeFile = document.querySelector('.change-file');
			if (changeFile) {
				changeFile.click();
				clicks.push({ action: 'changeFile', clicked: true });
			}

			return clicks;
		})()`);

		// 等待异步 DOM 与 diff 渲染
		await new Promise((r) => setTimeout(r, 2000));

		const afterInteract = await browser.evaluate(`(function() {
			return {
				marker: document.querySelectorAll('.marker').length,
				markerBody: document.querySelectorAll('.marker-body').length,
				raw: document.querySelectorAll('.raw').length,
				dl: document.querySelectorAll('.dl').length,
				hunk: document.querySelectorAll('.hunk').length,
				earlierLeft: document.querySelectorAll('.earlier').length,
				rawTextSnippet: document.querySelector('.raw')?.textContent || '',
				markerBodySnippet: document.querySelector('.marker-body')?.textContent || '',
			};
		})()`);

		// 断言展开后的元素存在且内容正确
		expect(afterInteract.earlierLeft).toBe(0);
		expect(afterInteract.marker).toBeGreaterThanOrEqual(2); // compaction + branch_summary
		expect(afterInteract.markerBody).toBeGreaterThanOrEqual(1);
		expect(afterInteract.markerBodySnippet).toContain("摘要正文");
		expect(afterInteract.raw).toBeGreaterThanOrEqual(1);
		expect(afterInteract.rawTextSnippet).toContain("SUCCESS");
		expect(afterInteract.rawTextSnippet).toContain("deep-search");
		expect(afterInteract.dl).toBeGreaterThanOrEqual(1);
	});

	it("只读收口：命令面板/快捷键/划词引用/本地链接/设置入口在只读页失效，保留项不受影响", async () => {
		// 1) 静态入口：侧栏底部不再渲染设置按钮；本地路径链接不是 <a>；保留项（下载原始 JSONL、侧栏筛选）仍在。
		const entries = await browser.evaluate(`(function() {
			var q = function (s) { return document.querySelectorAll(s).length };
			var dl = document.querySelector(".export-side-foot button.export-side-download");
			var body = (document.querySelector(".transcript") || { textContent: "" }).textContent || "";
			return {
				sidebarFootNavBtns: q(".sidebar-foot .nav-btn"),
				footHasSettingsText: ((document.querySelector(".sidebar-foot") || { textContent: "" }).textContent || "").indexOf("设置") >= 0,
				localAnchors: q("a[data-local-path]"),
				hasProbeText: body.indexOf("应用入口探针") >= 0,
				probeAnchors: [].filter.call(document.querySelectorAll(".transcript a"), function (n) { return (n.textContent || "").indexOf("应用入口探针") >= 0 }).length,
				downloadExists: !!dl,
				downloadDisabled: dl ? !!dl.disabled : true,
				filterInputs: q(".sidebar-search input"),
				fileInputs: q("input[type=file]"),
			};
		})()`);
		expect(entries.sidebarFootNavBtns).toBe(0);
		expect(entries.footHasSettingsText).toBe(false);
		expect(entries.localAnchors).toBe(0);
		expect(entries.hasProbeText).toBe(true);
		expect(entries.probeAnchors).toBe(0);
		expect(entries.downloadExists).toBe(true);
		expect(entries.downloadDisabled).toBe(false);
		expect(entries.filterInputs).toBeGreaterThan(0);
		expect(entries.fileInputs).toBe(0);

		// 2) 命令面板：Ctrl+Alt+K 打开后，写服务端/开设置/改语言主题/再导出的条目全部消失，
		//    保留「显示/隐藏侧栏」与对话跳转，且过滤后没有空分组。
		const HIDDEN_LABELS = [
			"新对话",
			"压缩上下文",
			"Commit 改动",
			"Push 到上游",
			"撤销或保留任务改动",
			"Git 工具与 Worktree",
			"切换模型",
			"设置",
			"Provider 与 API Key",
			"导出对话为 HTML",
			"主题：深色",
			"主题：浅色",
			"主题：跟随系统",
			"语言：English",
			"语言：简体中文",
		];
		await browser.evaluate(`(function() {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
			return true;
		})()`);
		await new Promise((r) => setTimeout(r, 600));
		const palette = await browser.evaluate(`(function() {
			var labels = [].map.call(document.querySelectorAll(".palette .palette-item .truncate"), function (n) { return (n.textContent || "").trim() });
			var emptyGroups = [].filter.call(document.querySelectorAll(".palette-list .pop-group"), function (n) {
				return !n.nextElementSibling || !n.nextElementSibling.classList.contains("palette-item");
			}).length;
			return { open: !!document.querySelector(".palette"), labels: labels, emptyGroups: emptyGroups };
		})()`);
		expect(palette.open).toBe(true);
		const hits = HIDDEN_LABELS.filter((label) => palette.labels.includes(label));
		expect(hits, `只读命令面板不应包含条目: ${hits.join("、")}`).toEqual([]);
		expect(palette.labels).toContain("显示/隐藏侧栏");
		expect(palette.emptyGroups).toBe(0);
		// 关闭命令面板
		await browser.evaluate(`(function() {
			var input = document.querySelector(".palette-input input");
			if (input) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			return true;
		})()`);
		await new Promise((r) => setTimeout(r, 400));

		// 3) 快捷键 Ctrl+Alt+N：包一层 fakeFetch 计数，派发后 fetch 增量为 0、无 toast（改前会发出被 405 拒绝的新对话 POST）。
		const counter = await browser.evaluate(`(function() {
			var E = window.__MYHARNESS_EXPORT__;
			if (E && typeof E.fetch === "function" && !E.__W125_ORIG_FETCH__) {
				E.__W125_ORIG_FETCH__ = E.fetch;
				window.__W125_FETCH_CALLS__ = 0;
				E.fetch = function () { window.__W125_FETCH_CALLS__++; return E.__W125_ORIG_FETCH__.apply(E, arguments); };
			}
			return { installed: !!(E && E.__W125_ORIG_FETCH__), calls: window.__W125_FETCH_CALLS__ || 0, paletteOpen: !!document.querySelector(".palette") };
		})()`);
		expect(counter.installed).toBe(true);
		expect(counter.paletteOpen).toBe(false);
		await browser.evaluate(`(function() {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
			return true;
		})()`);
		await new Promise((r) => setTimeout(r, 600));
		const afterNewChatKey = await browser.evaluate(`(function() {
			return { calls: window.__W125_FETCH_CALLS__ || 0, toasts: document.querySelectorAll(".toast").length };
		})()`);
		expect(afterNewChatKey.calls - counter.calls).toBe(0);
		expect(afterNewChatKey.toasts).toBe(0);

		// 4) 划词引用：FloatingQuoteToolbar 在只读页不挂载；选中正文后没有 Quote 气泡与批注卡片，原生选区（复制）不受影响。
		const selection = await browser.evaluate(`(function() {
			var target = document.querySelector(".transcript .final") || document.querySelector(".transcript .user-row .user-text");
			if (!target) return { found: false, selectedChars: 0 };
			var range = document.createRange();
			range.selectNodeContents(target);
			var sel = window.getSelection();
			sel.removeAllRanges();
			sel.addRange(range);
			document.dispatchEvent(new Event("selectionchange"));
			return { found: true, selectedChars: String(sel.toString()).length };
		})()`);
		expect(selection.found).toBe(true);
		expect(selection.selectedChars).toBeGreaterThan(0);
		await new Promise((r) => setTimeout(r, 400));
		const quote = await browser.evaluate(`(function() {
			return {
				bar: !!document.querySelector(".floating-quote-bar"),
				card: !!document.querySelector(".quote-note-card"),
				selectionChars: String(window.getSelection().toString()).length,
			};
		})()`);
		expect(quote.bar).toBe(false);
		expect(quote.card).toBe(false);
		expect(quote.selectionChars).toBeGreaterThan(0);
		await browser.evaluate(
			`(function() { var s = window.getSelection(); if (s) s.removeAllRanges(); return true })()`,
		);

		// 5) 保留的折叠/展开由上一用例实测（「显示更早的消息」全部展开、摘要/原始结果/diff 展开）；下载与侧栏筛选已在本用例第 1 步断言。
	});
});
