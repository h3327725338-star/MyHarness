// Chinese one-line descriptions for the built-in tools listed in the right sidebar (SPEC item G).
//
// These strings are display-only. They are keyed by tool *name*, never by the tool's model-facing
// description, so nothing here is compared against or written back to a tool definition: the name,
// description and parameters the model receives stay exactly as src/tools/ defines them.
//
// This file lives in locales/ on purpose: test/web-i18n.test.ts keeps Chinese characters out of
// web/js/*.js (it does not descend into locales/), and the translations must not leak into English
// mode, so the lookup happens behind `isZh()` in panel-context.js. Extension / MCP / third-party
// tools are never looked up here; they keep their own English description.
//
// Every name in src/tools/registry.ts `allToolNames` must have an entry here — test/web-tool-descriptions-zh.test.ts
// reads that set and fails the build when a new built-in tool is added without a Chinese sentence.

export const zhToolDescriptions = {
	read: "读取并解析文本、图片及各类文档",
	bash: "运行 Bash 命令",
	pwsh: "运行 PowerShell 命令",
	job_list: "列出后台任务及其运行状态",
	job_output: "读取后台任务已产生的输出",
	job_kill: "终止指定的后台任务",
	edit: "精确替换文件文本",
	write: "创建或完整重写文件",
	apply_patch: "用补丁一次性修改多个文件",
	grep: "搜索文件内容",
	find: "按名称查找文件",
	ls: "列出文件与文件夹",
	symbols: "查询代码符号与引用",
	agent: "委派任务给子 Agent",
	workflow: "分阶段只读探索，用于多模块并行排查与验证",
	ultracode: "高风险深度排查，结合反例检查与失败路径校验",
	agent_tasks: "查看或停止本对话的子智能体",
	github: "访问已连接的 GitHub 资源",
	memory_search: "搜索已保存的长期记忆",
	memory_get: "按编号读取完整记忆内容",
	memory_delete: "彻底删除指定的长期记忆",
	memory_claim: "把待认领记忆收为当前工作区记忆",
	ask_user_question: "向用户提问并等待选择或回答",
	todo_write: "创建并更新任务清单",
	web_search: "搜索网络并读取结果",
	web_fetch: "读取网页及文档",
};

/**
 * Sidebar text for one tool object from `GET /api/resources` (`{name, description, active, source, extension}`).
 * Returns `undefined` for extension tools and for names that have no entry, which makes the caller fall back to
 * the previous behaviour (the shared English short sentence, or the tool's own description).
 */
export function zhToolDescription(tool) {
	if (!tool || tool.extension) return undefined;
	const text = zhToolDescriptions[tool.name];
	return typeof text === "string" && text.length > 0 ? text : undefined;
}
