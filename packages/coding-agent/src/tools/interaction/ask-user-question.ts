/**
 * ask_user_question: asks the user one to four questions through the host's dialogs and returns the answers.
 *
 * Questions are asked in order. A question with options opens a single-choice dialog; unless `allowOther` is false
 * it also offers an "other" choice that opens a text dialog. A question without options opens a text dialog. Where the
 * host allows it, a text answer may carry images (pasted screenshots); they are returned to the model as images.
 * Closing a dialog never produces an invented answer: the tool stops asking and tells the model that the user gave
 * no answer. A host without a dialog-capable UI (SDK, delegated or headless runs) makes the tool throw
 * NO_INTERACTIVE_UI. A stopped run withdraws the open dialog and throws instead of answering.
 */

import type { AgentTool } from "@myharness/agent-core";
import type { ImageContent } from "@myharness/ai";
import { type Static, Type } from "typebox";
import type { ExtensionUIContextPort } from "../../extensions/contracts/ui.ts";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";

const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_HEADER_CHARS = 12;
const OTHER_CHOICE = "其他（自己输入）";
const TEXT_PLACEHOLDER = "请输入你的回答（可粘贴图片）";
const IMAGES_ONLY_ANSWER = "（用户只附上了图片，见下方图片）";
export const NO_INTERACTIVE_UI_CODE = "NO_INTERACTIVE_UI";

const questionSchema = Type.Object({
	question: Type.String({ description: "The question to ask, complete enough for the user to answer on its own." }),
	header: Type.Optional(
		Type.String({ description: `Short label for the question, at most ${MAX_HEADER_CHARS} characters.` }),
	),
	options: Type.Optional(
		Type.Array(Type.String(), {
			minItems: MIN_OPTIONS,
			maxItems: MAX_OPTIONS,
			description: `Mutually exclusive choices (${MIN_OPTIONS} to ${MAX_OPTIONS}). Omit for a free-text question.`,
		}),
	),
	allowOther: Type.Optional(
		Type.Boolean({ description: "With options, also offer a choice that takes a typed answer. Defaults to true." }),
	),
});

const askUserQuestionSchema = Type.Object({
	questions: Type.Array(questionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: `One to ${MAX_QUESTIONS} questions, asked in order.`,
	}),
});

type QuestionInput = Static<typeof questionSchema>;

export type AskUserQuestionToolInput = Static<typeof askUserQuestionSchema>;

export interface AskUserQuestionAnswer {
	question: string;
	header?: string;
	/** The user's answer; absent when the user gave none. */
	answer?: string;
	/** "option": a listed choice; "other": typed text; "dismissed": the user gave no answer. */
	source: "option" | "other" | "dismissed";
	/** Number of images the user attached to a typed answer; the images themselves are in the tool result. */
	images?: number;
}

export interface AskUserQuestionToolDetails {
	answers: AskUserQuestionAnswer[];
}

/**
 * Models used to other agents' question tools send each option as `{ label, description }`; the dialog lists plain
 * text, so such an option becomes "label — description" instead of failing validation and costing the model a round
 * trip (6 of 22 calls in a week of real use failed that way). Anything else is left for validation to report.
 */
function prepareAskUserQuestionArguments(args: unknown): AskUserQuestionToolInput {
	const input = args as { questions?: unknown } | undefined;
	if (!input || typeof input !== "object" || !Array.isArray(input.questions)) return args as AskUserQuestionToolInput;
	let changed = false;
	const questions = input.questions.map((question: unknown) => {
		const options = (question as { options?: unknown } | undefined)?.options;
		if (!Array.isArray(options)) return question;
		return {
			...(question as object),
			options: options.map((option: unknown) => {
				const text = optionText(option);
				if (text === undefined) return option;
				changed = true;
				return text;
			}),
		};
	});
	return (changed ? { ...input, questions } : args) as AskUserQuestionToolInput;
}

function optionText(option: unknown): string | undefined {
	if (!option || typeof option !== "object" || Array.isArray(option)) return undefined;
	const { label, description } = option as { label?: unknown; description?: unknown };
	if (typeof label !== "string" || !label.trim()) return undefined;
	return typeof description === "string" && description.trim()
		? `${label.trim()} — ${description.trim()}`
		: label.trim();
}

/** A question after validation: options are trimmed and unique, and absent for free-text questions. */
interface PlannedQuestion {
	question: string;
	header?: string;
	options?: string[];
	allowOther: boolean;
}

function planQuestions(input: AskUserQuestionToolInput | undefined): PlannedQuestion[] {
	const questions = input?.questions;
	if (!Array.isArray(questions) || questions.length < 1 || questions.length > MAX_QUESTIONS) {
		const count = Array.isArray(questions) ? questions.length : 0;
		throw new Error(`questions 需要 1 到 ${MAX_QUESTIONS} 个问题（当前 ${count} 个）。`);
	}
	return questions.map((item, index) => planQuestion(item, index + 1));
}

function planQuestion(item: QuestionInput, position: number): PlannedQuestion {
	const question = typeof item?.question === "string" ? item.question.trim() : "";
	if (!question) throw new Error(`第 ${position} 个问题的 question 不能为空。`);
	const header = typeof item.header === "string" ? item.header.trim() : "";
	if ([...header].length > MAX_HEADER_CHARS) {
		throw new Error(`第 ${position} 个问题的 header 不能超过 ${MAX_HEADER_CHARS} 个字符。`);
	}
	const planned: PlannedQuestion = {
		question,
		allowOther: item.allowOther !== false,
		...(header ? { header } : {}),
	};
	if (item.options === undefined) return planned;
	const rawOptions = item.options;
	if (!Array.isArray(rawOptions) || rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
		const count = Array.isArray(rawOptions) ? rawOptions.length : 0;
		throw new Error(
			`第 ${position} 个问题的 options 需要 ${MIN_OPTIONS} 到 ${MAX_OPTIONS} 个选项（当前 ${count} 个）。`,
		);
	}
	const options = rawOptions.map((option) => (typeof option === "string" ? option.trim() : ""));
	if (options.some((option) => !option)) throw new Error(`第 ${position} 个问题的选项不能为空。`);
	const choices = planned.allowOther ? [...options, OTHER_CHOICE] : options;
	if (new Set(choices).size !== choices.length) {
		throw new Error(`第 ${position} 个问题的选项重复（“${OTHER_CHOICE}”也算一个选项）。`);
	}
	return { ...planned, options };
}

async function askQuestion(
	ui: ExtensionUIContextPort,
	planned: PlannedQuestion,
	signal: AbortSignal | undefined,
	images: ImageContent[],
): Promise<AskUserQuestionAnswer> {
	const base = { question: planned.question, ...(planned.header ? { header: planned.header } : {}) };
	const askText = async () => {
		let attached: ImageContent[] = [];
		const text = await ui.input(planned.question, TEXT_PLACEHOLDER, {
			signal,
			onImages: (received) => {
				attached = received.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
			},
		});
		const answer = answerFromText(base, text, attached.length);
		if (answer.source === "other") images.push(...attached);
		return answer;
	};
	if (!planned.options) return askText();
	const choices = planned.allowOther ? [...planned.options, OTHER_CHOICE] : planned.options;
	const picked = await ui.select(planned.question, choices, { signal });
	if (picked !== undefined && planned.options.includes(picked)) {
		return { ...base, answer: picked, source: "option" };
	}
	if (picked === OTHER_CHOICE && planned.allowOther) return askText();
	return { ...base, source: "dismissed" };
}

function answerFromText(
	base: Pick<AskUserQuestionAnswer, "question" | "header">,
	text: string | undefined,
	imageCount = 0,
): AskUserQuestionAnswer {
	// A submitted answer may be images alone; a dismissed dialog (undefined) never counts as an answer.
	const answer = text?.trim() || (text !== undefined && imageCount ? IMAGES_ONLY_ANSWER : "");
	if (!answer) return { ...base, source: "dismissed" };
	return { ...base, answer, source: "other", ...(imageCount ? { images: imageCount } : {}) };
}

function formatAnswers(answers: AskUserQuestionAnswer[], questionCount: number): string {
	const numbered = questionCount > 1;
	const lines: string[] = [];
	answers.forEach((item, index) => {
		const label = numbered ? `${index + 1}. ` : "";
		const indent = numbered ? "   " : "";
		lines.push(`${label}问题：${item.question}`, `${indent}回答：${item.answer ?? "（用户没有回答）"}`);
		if (item.images) lines.push(`${indent}附图：${item.images} 张（按回答顺序附在本结果末尾）`);
	});
	if (answers.some((item) => item.source === "dismissed")) {
		lines.push("", "用户关闭了提问，请不要自行假设答案，改为说明你需要什么信息或选择一个保守的默认方案并告知用户。");
		const unasked = questionCount - answers.length;
		if (unasked > 0) lines.push(`后面 ${unasked} 个问题没有继续提出。`);
	}
	return lines.join("\n");
}

/** The execution context must carry a dialog-capable UI; headless and delegated runs have none. */
function requireInteractiveUi(ctx: unknown): ExtensionUIContextPort {
	const context = ctx as { hasUI?: unknown; ui?: ExtensionUIContextPort } | undefined;
	if (!context || context.hasUI !== true || !context.ui) {
		throw Object.assign(
			new Error("当前会话没有可交互的界面，无法向用户提问；请自行做出最合理的假设并在回答里说明。"),
			{ code: NO_INTERACTIVE_UI_CODE },
		);
	}
	return context.ui;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

export function createAskUserQuestionToolDefinition(): BusinessToolDefinition<
	typeof askUserQuestionSchema,
	AskUserQuestionToolDetails
> {
	return {
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user one to four questions in an interactive dialog and wait for the answers. A question may offer 2 to 6 mutually exclusive options; unless allowOther is false, an extra choice lets the user type their own answer. A question without options takes free text. Answers come back in the order asked. If the user closes a dialog, the tool stops asking and reports that no answer was given. Fails with NO_INTERACTIVE_UI when the session has no interactive UI.",
		promptSnippet: loadSystemPrompt("tools/ask-user-question/snippet.md"),
		parameters: askUserQuestionSchema,
		prepareArguments: prepareAskUserQuestionArguments,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const ui = requireInteractiveUi(ctx);
			throwIfAborted(signal);
			const questions = planQuestions(params);
			const answers: AskUserQuestionAnswer[] = [];
			const images: ImageContent[] = [];
			for (const planned of questions) {
				const answer = await askQuestion(ui, planned, signal, images);
				throwIfAborted(signal);
				answers.push(answer);
				if (answer.source === "dismissed") break;
			}
			return {
				content: [{ type: "text", text: formatAnswers(answers, questions.length) }, ...images],
				details: { answers },
			};
		},
	};
}

export function createAskUserQuestionTool(): AgentTool<typeof askUserQuestionSchema> {
	return wrapToolDefinition(createAskUserQuestionToolDefinition());
}
