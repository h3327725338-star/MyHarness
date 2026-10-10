/**
 * todo_write: keeps the task list of the current multi-step work.
 *
 * Every call carries the complete list and replaces the previous one. Nothing is stored outside the conversation:
 * the tool call and its result are part of the transcript, so a resumed session shows the last list the model wrote.
 */

import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";

const MAX_TODOS = 50;
const STATUSES: readonly string[] = ["pending", "in_progress", "completed"];
const MARKERS = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;

const todoStatusSchema = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
	description: "pending: not started; in_progress: being worked on now (at most one); completed: finished.",
});

const todoItemSchema = Type.Object({
	content: Type.String({ description: "What to do, as a short imperative phrase, for example 'Add unit tests'." }),
	status: todoStatusSchema,
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous wording shown while in progress, for example 'Adding unit tests'.",
		}),
	),
});

const todoWriteSchema = Type.Object({
	todos: Type.Array(todoItemSchema, {
		maxItems: MAX_TODOS,
		description: `The complete todo list after this update, at most ${MAX_TODOS} items. An empty array clears the list.`,
	}),
});

export type TodoWriteToolInput = Static<typeof todoWriteSchema>;
export type TodoWriteItem = Static<typeof todoItemSchema>;
export type TodoWriteStatus = Static<typeof todoStatusSchema>;

export interface TodoWriteCounts {
	total: number;
	completed: number;
	inProgress: number;
	pending: number;
}

export interface TodoWriteToolDetails {
	todos: TodoWriteItem[];
	counts: TodoWriteCounts;
}

/**
 * Validates the whole list. Duplicate content is an error rather than a silent merge: a merge would change the item
 * count the model is tracking, while an error lets the model correct its own list.
 */
function normalizeTodos(input: TodoWriteToolInput | undefined): TodoWriteItem[] {
	const raw = input?.todos;
	if (!Array.isArray(raw)) throw new Error("todos 必须是数组。");
	if (raw.length > MAX_TODOS) throw new Error(`待办最多 ${MAX_TODOS} 项（当前 ${raw.length} 项）。`);
	const contents = new Set<string>();
	const inProgress: string[] = [];
	const todos = raw.map((item, index) => {
		const position = index + 1;
		const content = typeof item?.content === "string" ? item.content.trim() : "";
		if (!content) throw new Error(`第 ${position} 项的 content 不能为空。`);
		if (!STATUSES.includes(item.status)) {
			throw new Error(`第 ${position} 项的 status 必须是 pending、in_progress 或 completed。`);
		}
		if (contents.has(content))
			throw new Error(`待办内容重复：“${content}”（第 ${position} 项）。同一内容只能出现一次。`);
		contents.add(content);
		if (item.status === "in_progress") inProgress.push(content);
		const activeForm = typeof item.activeForm === "string" ? item.activeForm.trim() : "";
		return { content, status: item.status, ...(activeForm ? { activeForm } : {}) };
	});
	if (inProgress.length > 1) {
		const names = inProgress.map((text) => `“${text}”`).join("、");
		throw new Error(
			`同一时间最多只能有一项 in_progress，当前有 ${inProgress.length} 项：${names}。请只保留一项进行中，其余改为 pending 或 completed。`,
		);
	}
	return todos;
}

function countTodos(todos: TodoWriteItem[]): TodoWriteCounts {
	return {
		total: todos.length,
		completed: todos.filter((item) => item.status === "completed").length,
		inProgress: todos.filter((item) => item.status === "in_progress").length,
		pending: todos.filter((item) => item.status === "pending").length,
	};
}

function formatTodos(todos: TodoWriteItem[], counts: TodoWriteCounts): string {
	if (todos.length === 0) return "待办清单已清空。";
	const summary = `待办清单已更新：共 ${counts.total} 项，完成 ${counts.completed}，进行中 ${counts.inProgress}，待做 ${counts.pending}。`;
	return [summary, ...todos.map((item) => `${MARKERS[item.status]} ${item.content}`)].join("\n");
}

export function createTodoWriteToolDefinition(): BusinessToolDefinition<typeof todoWriteSchema, TodoWriteToolDetails> {
	return {
		name: "todo_write",
		label: "todo_write",
		description:
			"Create or replace the task list for multi-step work. Each call sends the complete list, at most 50 items, and replaces the previous one; an empty array clears it. At most one item may be in_progress. Use it for work with three or more steps or several requests from the user; skip it for a single small step.",
		promptSnippet: loadSystemPrompt("tools/todo-write/snippet.md"),
		parameters: todoWriteSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const todos = normalizeTodos(params);
			const counts = countTodos(todos);
			return {
				content: [{ type: "text", text: formatTodos(todos, counts) }],
				details: { todos, counts },
			};
		},
	};
}

export function createTodoWriteTool(): AgentTool<typeof todoWriteSchema> {
	return wrapToolDefinition(createTodoWriteToolDefinition());
}
