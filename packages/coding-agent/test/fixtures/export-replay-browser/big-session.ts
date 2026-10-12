/**
 * W27c — big-session fixture for the web export replay browser E2E tests.
 *
 * Builds a session with more than 65 turns and a few megabytes of JSONL so the
 * browser tests cover the "show earlier messages" paging (transcript.js renders
 * at most 60 turns initially, +60 per click) plus the compaction and branch
 * markers. Reuses the loose builders from the shared harness; no new helpers.
 */

import { join } from "node:path";
import { SessionManager } from "../../../src/session/manager/index.ts";
import { codeBlock, diffPatch, message, PNG, runChangesData, tableMd, usage, usageOf } from "./harness.ts";

export const BIG_NAME = "W27c 导出端到端大对话";

/** Number of user turns on the final path (plus standalone marker/action turns). */
export const BIG_TURNS = 70;

type PngKey = keyof typeof PNG;
const PNG_KEYS: PngKey[] = ["red", "green", "blue"];

const TOOL_CYCLE = ["read", "bash", "edit", "write", "web_search", "find", "grep", "ls"] as const;

function toolDetails(name: string, turn: number): Record<string, unknown> {
	switch (name) {
		case "bash":
			return {
				exitCode: turn % 11 === 0 ? 1 : 0,
				signal: null,
				durationMs: 400 + turn,
				cwd: "C:/probe/big-workspace",
				truncated: false,
			};
		case "edit":
			return {
				diff: diffPatch(`src/module-${turn}.ts`, turn, turn + 1),
				files: [{ path: `src/module-${turn}.ts`, added: 3, removed: 1, status: "M" }],
			};
		case "write":
			return { additions: 42, deletions: 3, path: `src/module-${turn}.ts` };
		case "web_search":
			return { rounds: 1, resultsReturned: 5, pagesOpened: 2, failures: [], engines: ["bing", "ddg"] };
		case "read":
			return { kind: "file", path: `src/module-${turn}.ts`, truncated: false, added: 60, removed: 0 };
		default:
			return { note: `工具 ${name} 的 details 字段`, turn };
	}
}

function toolArgs(name: string, mod: number): Record<string, unknown> {
	switch (name) {
		case "read":
			return { path: `C:/probe/big-workspace/src/module-${mod}.ts`, offset: mod, limit: 200 };
		case "bash":
			return { command: `rg -n "边界条件" src/module-${mod}.ts` };
		case "edit":
			return { path: `C:/probe/big-workspace/src/module-${mod}.ts` };
		case "write":
			return { path: `C:/probe/big-workspace/src/module-${mod}.ts` };
		case "web_search":
			return { query: `边界条件 模块${mod}` };
		case "find":
			return { pattern: "module-*.ts", path: "C:/probe/big-workspace/src" };
		case "grep":
			return { pattern: "TODO", path: "C:/probe/big-workspace/src" };
		default:
			return { path: "C:/probe/big-workspace/src" };
	}
}

export function buildBigSession(rootDir: string): SessionManager {
	const sm = SessionManager.create(join(rootDir, "project-big"), join(rootDir, "sessions-big"));
	const stamp = Date.now();
	let clock = 0;
	const tick = (): number => stamp + clock++;

	sm.appendSessionInfo(BIG_NAME);
	sm.appendModelChange("probe-provider", "probe-model-max");
	sm.appendThinkingLevelChange("high");

	// First user message: the branch_summary marker re-attaches here, so both
	// markers end up on the final path (same shape as buildSmallSession).
	const firstUser = sm.appendMessage(
		message({
			role: "user",
			content: [
				{
					type: "text",
					text: '第 0 轮：请检查 src/module-0.ts 的边界条件。<attachment path="C:/probe/big-workspace/notes-0.md" />',
				},
				{ type: "image", mimeType: "image/png", data: PNG.red },
			],
			timestamp: tick(),
		}),
	);
	sm.branchWithSummary(
		firstUser,
		`从另一条分支回到主线（大样本）：那条分支试过整体重写日志层，未采纳。${"补充说明".repeat(120)}`,
		{ dropped: 12 },
		false,
		usage(usageOf(1200, 200, 1400)),
	);

	for (let turn = 1; turn <= BIG_TURNS; turn++) {
		const mod = turn % 8;
		const userContent: unknown[] = [
			{
				type: "text",
				text:
					`第 ${turn} 轮：请检查 src/module-${mod}.ts 里的边界条件，并把日志补齐。` +
					`<attachment path="C:/probe/big-workspace/notes-${turn}.md" />`,
			},
		];
		if (turn % 9 === 0) {
			userContent.push({
				type: "image",
				mimeType: "image/png",
				data: PNG[PNG_KEYS[Math.floor(turn / 9) % PNG_KEYS.length] as PngKey],
			});
		}
		sm.appendMessage(message({ role: "user", content: userContent, timestamp: tick() }));

		const name = TOOL_CYCLE[(turn - 1) % TOOL_CYCLE.length] as string;
		const callId = `call-big-${turn}-${name}`;
		const thinking =
			turn === 3
				? {
						type: "thinking",
						thinking: "网页搜索辅助确认（大样本）。",
						redacted: true,
						thinkingSignature: "sig_redacted",
					}
				: {
						type: "thinking",
						thinking: `想一下第 ${turn} 步：先看 ${name} 的输出，再决定要不要改文件。${"排查边界条件与日志缺口。".repeat(6)}`,
					};
		sm.appendMessage(
			message({
				role: "assistant",
				api: "anthropic-messages",
				provider: "probe-provider",
				model: "probe-model-max",
				stopReason: "toolUse",
				timestamp: tick(),
				usage: usageOf(800 + turn * 3, 300 + turn, 1100 + turn * 4),
				content: [
					thinking,
					{
						type: "text",
						text: [
							`### 第 ${turn} 轮小结`,
							"",
							`这一轮调用 \`${name}\`，下面是表格与代码：`,
							"",
							tableMd(6),
							"",
							"```ts",
							codeBlock(12),
							"```",
						].join("\n"),
					},
					{ type: "toolCall", id: callId, name, arguments: toolArgs(name, mod) },
				],
			}),
		);

		// A few long results carry the bulk of the 2–6 MB budget.
		const longLines = turn % 10 === 1 ? 2500 : 150;
		const resultContent: unknown[] = [{ type: "text", text: codeBlock(longLines) }];
		if (turn % 15 === 7) resultContent.push({ type: "image", mimeType: "image/png", data: PNG.blue });
		sm.appendMessage(
			message({
				role: "toolResult",
				toolCallId: callId,
				toolName: name,
				isError: turn % 23 === 5,
				timestamp: tick(),
				content: resultContent,
				details: toolDetails(name, turn),
			}),
		);

		// Standalone cards. One of each kind must survive in the last 60 turns,
		// because the pre-interaction category assertions only see the first screen.
		if (turn % 17 === 0) {
			sm.appendMessage(
				message({
					role: "bashExecution",
					command: `git status --porcelain  # 大样本第 ${turn} 轮`,
					output: codeBlock(20).replace(/export const/g, " M src"),
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timedOut: false,
					fullOutputPath: `C:/probe/big-workspace/temporary/bash-${turn}.txt`,
					excludeFromContext: false,
					timestamp: tick(),
				}),
			);
		}
		if (turn % 23 === 0) {
			sm.appendCustomEntry("web-git-status", {
				action: "commit",
				ok: true,
				hash: `w27big${String(turn).padStart(2, "0")}`,
				message: `chore: 大样本第 ${turn} 批改动`,
				at: new Date(stamp).toISOString(),
			});
			sm.appendCustomEntry("web-run-changes", runChangesData(`big${turn}`));
			sm.appendCustomMessageEntry(
				"permission-gate",
				`扩展提示：大样本第 ${turn} 轮请求写入 C:/probe/big-workspace/src/module-${mod}.ts`,
				true,
				{ rule: "write", turn },
			);
		}
		// Compaction near the end of the loop so its marker is recent enough to
		// stay in the first screen, while the branch marker sits near the top.
		if (turn === BIG_TURNS - 2) {
			sm.appendCompaction(
				`前情摘要（大样本第 ${turn} 轮）：已排查 ${turn} 个模块的边界条件，改掉了日志缺口；剩余问题是 3 个超时用例。${"细节".repeat(200)}`,
				firstUser,
				205000 + turn * 100,
				{ trigger: "manual", keptEntries: 18 },
				false,
				usage(usageOf(9000, 700, 9700)),
			);
		}
	}

	// Closing answer: the last assistant message has no tool call, so turn.final
	// renders (.final + .msg-meta in the last visible turn).
	sm.appendMessage(
		message({
			role: "assistant",
			api: "anthropic-messages",
			provider: "probe-provider",
			model: "probe-model-max",
			stopReason: "stop",
			timestamp: tick(),
			usage: usageOf(120, 480, 600),
			content: [
				{
					type: "text",
					text: [
						`最终确认：一共 ${BIG_TURNS} 轮、变更卡片 ${Math.floor(BIG_TURNS / 23)} 张，压缩与分支摘要各一条，验证通过。`,
						"",
						tableMd(3),
						"",
						"```ts",
						codeBlock(8),
						"```",
					].join("\n"),
				},
			],
		}),
	);

	// Abandoned side branch, then back to the main path.
	const mainLeaf = sm.getLeafId();
	sm.branch(firstUser);
	sm.appendMessage(
		message({
			role: "user",
			content: [{ type: "text", text: `旁支第 0 条：这条分支没有并回主线。${"旁支内容".repeat(30)}` }],
			timestamp: tick(),
		}),
	);
	sm.appendMessage(
		message({
			role: "assistant",
			provider: "probe-provider",
			model: "probe-model-fast",
			stopReason: "stop",
			timestamp: tick(),
			usage: usageOf(10, 20, 30),
			content: [{ type: "text", text: `旁支第 1 条：确认旁支结构。${"旁支内容".repeat(10)}` }],
		}),
	);
	if (mainLeaf) sm.branch(mainLeaf);
	return sm;
}
