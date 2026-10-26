import { estimateTextTokens } from "@myharness/ai";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { runGitAsync } from "../repository/integration.ts";
import { type CommitAnalysisOptions, type CommitMessageContext, requestBudget, splitDiff } from "./ai-message.ts";
import { type ModelCompletion, parseModelJsonWithRepair } from "./model-json.ts";

/** What the user's own instructions decided about one commit or push. */
export interface GitInstructionReview {
	/** Why the instructions stop the operation; absent when it may go on. */
	stop?: string;
	/** The push instructions ask for CI to pass (failing CI is then fixed and pushed again). */
	fixCi: boolean;
}

export type GitReviewOperation = "commit" | "push";

/**
 * Read what a push would publish: the diff between the upstream commit and the commit being pushed, and the messages of
 * the commits in between. No file is read from the working tree.
 */
export async function readPushReviewContext(
	repositoryRoot: string,
	upstreamSha: string,
	localSha: string,
	signal?: AbortSignal,
): Promise<CommitMessageContext> {
	const range = `${upstreamSha}..${localSha}`;
	const [diff, names, log] = await Promise.all([
		runGitAsync(repositoryRoot, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", range], undefined, signal),
		runGitAsync(repositoryRoot, ["diff", "--name-only", "-z", "--no-renames", range], undefined, signal),
		runGitAsync(repositoryRoot, ["log", "--format=%B%x00", range], undefined, signal),
	]);
	if (!diff.ok) throw new Error(diff.stderr || diff.error || "Cannot read the commits to push.");
	if (!names.ok) throw new Error(names.stderr || names.error || "Cannot read the files to push.");
	if (!log.ok) throw new Error(log.stderr || log.error || "Cannot read the commit messages to push.");
	return { paths: names.stdout.split("\0").filter(Boolean), diff: diff.stdout, history: log.stdout.slice(0, 20_000) };
}

function readReview(value: unknown): GitInstructionReview {
	if (!value || typeof value !== "object") throw new Error("The review of your Git instructions returned no result.");
	const { stop, fixCi } = value as { stop?: unknown; fixCi?: unknown };
	if (stop !== undefined && stop !== false && stop !== null && (typeof stop !== "string" || !stop.trim()))
		throw new Error("The review of your Git instructions returned an invalid result.");
	return { ...(typeof stop === "string" ? { stop: stop.trim() } : {}), fixCi: fixCi === true };
}

/**
 * Check a commit's or a push's changes against the user's own instructions with tool-free model requests. A change
 * larger than one request is checked part by part, and the first part that stops the operation ends the review. No
 * instructions means nothing to check.
 */
export async function reviewWithInstructions(
	context: CommitMessageContext,
	operation: GitReviewOperation,
	instructions: string,
	complete: ModelCompletion,
	options: Omit<CommitAnalysisOptions, "instructions"> = {},
): Promise<GitInstructionReview> {
	const text = instructions.trim();
	if (!text) return { fixCi: false };
	const base = loadSystemPrompt("tasks/git-review.md");
	if (!base.trim()) throw new Error("The Git review prompt is unavailable.");
	const prompt = `${base}\n\n<user_instructions>\n${text}\n</user_instructions>`;
	const budget = requestBudget(options);
	const fits = (input: unknown) => estimateTextTokens(prompt) + estimateTextTokens(JSON.stringify(input)) <= budget;
	const ask = async (input: unknown): Promise<GitInstructionReview> => {
		options.signal?.throwIfAborted();
		const answer = await complete(prompt, JSON.stringify(input));
		options.signal?.throwIfAborted();
		return readReview(await parseModelJsonWithRepair(answer, complete, options.signal));
	};
	const messages = context.history.slice(0, Math.max(256, Math.floor(budget / 8)));
	const whole = { operation, paths: context.paths, messages, diff: context.diff };
	if (fits(whole)) return ask(whole);
	const parts = splitDiff(context, Math.max(128, Math.floor(budget / 4)));
	const build = (chunks: typeof parts, index: number, total: number) => ({
		operation,
		part: `${index}/${total}`,
		files: context.paths.length,
		messages: index === 1 ? messages : undefined,
		chunks: chunks.map((chunk) => ({ path: chunk.path, text: chunk.text })),
	});
	const groups: (typeof parts)[] = [];
	let current: typeof parts = [];
	for (const part of parts) {
		if (current.length && !fits(build([...current, part], 1, 1))) {
			groups.push(current);
			current = [];
		}
		if (!fits(build([part], 1, 1))) throw new Error("A part of the changes cannot fit the model input budget.");
		current.push(part);
	}
	if (current.length) groups.push(current);
	let fixCi = false;
	for (const [index, chunks] of groups.entries()) {
		options.onProgress?.(`正在按你的提示词检查改动（${index + 1}/${groups.length}）`);
		const review = await ask(build(chunks, index + 1, groups.length));
		if (review.stop) return review;
		fixCi ||= review.fixCi;
	}
	return { fixCi };
}
