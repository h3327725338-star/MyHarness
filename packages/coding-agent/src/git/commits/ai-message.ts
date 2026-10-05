import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { estimateTextTokens } from "@myharness/ai";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { runGitAsync } from "../repository/integration.ts";
import type { GeneratedCommitMessage } from "./message.ts";

export interface CommitMessageContext {
	paths: string[];
	diff: string;
	history: string;
}

/** Read the complete selected working-tree delta, including files absent from HEAD. Never silently omit a large diff. */
export async function readCommitMessageContext(
	repositoryRoot: string,
	paths: string[],
	signal?: AbortSignal,
): Promise<CommitMessageContext> {
	const filters = paths.map((file) => `:(literal)${file}`);
	const diff = await runGitAsync(
		repositoryRoot,
		["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--", ...filters],
		undefined,
		signal,
	);
	if (!diff.ok) throw new Error(diff.stderr || diff.error || "Cannot read the commit diff.");
	const untracked = await runGitAsync(
		repositoryRoot,
		["ls-files", "--others", "--exclude-standard", "-z", "--", ...filters],
		undefined,
		signal,
	);
	if (!untracked.ok) throw new Error(untracked.stderr || "Cannot read new commit files.");
	let delta = diff.stdout;
	for (const file of untracked.stdout.split("\0").filter(Boolean)) {
		const absolute = join(repositoryRoot, file);
		const info = await lstat(absolute);
		if (!info.isFile()) throw new Error(`Cannot describe non-regular new file: ${file}`);
		const bytes = await readFile(absolute);
		delta += `\nNew file ${JSON.stringify(file)}:\n${bytes.includes(0) ? `Binary file (contents omitted), SHA-256: ${createHash("sha256").update(bytes).digest("hex")}` : bytes.toString("utf8")}\n`;
	}
	const history = await runGitAsync(repositoryRoot, ["log", "-10", "--format=%B%x00"], undefined, signal);
	if (!history.ok) throw new Error(history.stderr || "Cannot read commit history.");
	return { paths, diff: delta, history: history.stdout.slice(0, 20_000) };
}

export interface CommitAnalysisOptions {
	contextWindow?: number;
	maxOutputTokens?: number;
	signal?: AbortSignal;
	onProgress?: (activity: string) => void;
}

interface DiffPart {
	id: string;
	path: string;
	text: string;
	/** Character range within this file's diff section (not source-code line numbers). */
	start: number;
	end: number;
}
interface Analysis {
	id: string;
	covered: string[];
	features: Array<{ description: string; sources: string[] }>;
	uncertainties: string[];
}

/** Conservative estimates, not a tokenizer guarantee. Unknown models use small batches, not a total-diff cap. */
function requestBudget(options: CommitAnalysisOptions): number {
	const window =
		options.contextWindow && Number.isFinite(options.contextWindow) && options.contextWindow > 0
			? options.contextWindow
			: 16_384;
	const output = options.maxOutputTokens ?? 4096;
	const budget = Math.floor(window * 0.65) - output - 1024;
	if (budget < 1024) throw new Error("Model context window is too small for commit analysis.");
	return budget;
}

function groupKey(path: string): string {
	return path
		.replace(/(^|\/)(test|tests|__tests__|docs)\//gu, "$1")
		.replace(/\.(test|spec)\.[^.]+$/u, "")
		.replace(/\.[^.]+$/u, "");
}

/** Preserve file/hunk boundaries when possible; oversized lines are split without dropping characters. */
function splitDiff(context: CommitMessageContext, maxTokens: number): DiffPart[] {
	const sections = context.diff.split(/(?=^diff --git |^New file )/mu).filter(Boolean);
	const parts: DiffPart[] = [];
	for (const section of sections) {
		const tracked = section.match(/^diff --git (?:"a\/(.*?)"|a\/(.*?)) (?:"b\/(.*?)"|b\/(.*?))\r?\n/u);
		const added = section.match(/^New file (".*"):\r?\n/u);
		const file = tracked
			? (tracked[3] ?? tracked[4])
			: added
				? (JSON.parse(added[1]) as string)
				: context.paths.length === 1
					? context.paths[0]
					: "(combined diff)";
		const hunks = section.split(/(?=^@@ )/mu);
		let pending = "";
		let offset = 0;
		const flush = () => {
			if (pending) {
				parts.push({
					id: `diff-${parts.length + 1}`,
					path: file,
					text: pending,
					start: offset,
					end: offset + pending.length,
				});
				offset += pending.length;
			}
			pending = "";
		};
		for (const hunk of hunks) {
			if (estimateTextTokens(pending + hunk) <= maxTokens) {
				pending += hunk;
				continue;
			}
			flush();
			if (estimateTextTokens(hunk) <= maxTokens) {
				pending = hunk;
				continue;
			}
			for (const line of hunk.split(/(?<=\n)/u)) {
				if (estimateTextTokens(pending + line) <= maxTokens) {
					pending += line;
					continue;
				}
				flush();
				// Array.from keeps Unicode code points intact at forced boundaries.
				let fragment = "";
				let fragmentBytes = 0;
				for (const character of line) {
					const bytes = Buffer.byteLength(character, "utf8");
					if (fragmentBytes + bytes > maxTokens * 4) {
						pending = fragment;
						flush();
						fragment = "";
						fragmentBytes = 0;
					}
					fragment += character;
					fragmentBytes += bytes;
				}
				pending = fragment;
			}
		}
		flush();
	}
	// Co-locate matching implementation/tests and resolvable relative imports present in the diff.
	// This is a grouping hint, not proof that files implement the same feature.
	const parents = new Map<string, string>();
	const root = (key: string): string => {
		const parent = parents.get(key);
		if (!parent || parent === key) return key;
		const value = root(parent);
		parents.set(key, value);
		return value;
	};
	const byPath = new Map(parts.map((part) => [part.path.replace(/\.[^.]+$/u, ""), groupKey(part.path)]));
	for (const part of parts) {
		const key = groupKey(part.path);
		for (const match of part.text.matchAll(/(?:from\s*|import\s*\(|require\s*\()?["'](\.[^"'\n]+)["']/gu)) {
			const target = posix.normalize(posix.join(posix.dirname(part.path), match[1])).replace(/\.[^./]+$/u, "");
			const related = byPath.get(target) ?? byPath.get(`${target}/index`);
			if (related && root(key) !== root(related)) parents.set(root(key), root(related));
		}
	}
	return parts.sort((a, b) => root(groupKey(a.path)).localeCompare(root(groupKey(b.path))));
}

async function describeInBatches(
	context: CommitMessageContext,
	prompt: string,
	complete: (systemPrompt: string, input: string) => Promise<string>,
	options: CommitAnalysisOptions,
): Promise<string> {
	const budget = requestBudget(options);
	const fits = (input: unknown) => estimateTextTokens(prompt) + estimateTextTokens(JSON.stringify(input)) <= budget;
	const ask = async (input: unknown): Promise<string> => {
		options.signal?.throwIfAborted();
		if (!fits(input)) throw new Error("Commit analysis request exceeds the model input budget.");
		const result = await complete(prompt, JSON.stringify(input));
		options.signal?.throwIfAborted();
		return result;
	};
	if (fits(context)) {
		options.onProgress?.("正在生成详细提交说明");
		return ask(context);
	}
	const modules = new Map<string, number>();
	for (const path of context.paths) {
		const module = path
			.split("/")
			.slice(0, path.startsWith("packages/") ? 2 : 1)
			.join("/");
		modules.set(module, (modules.get(module) ?? 0) + 1);
	}
	// Large manifests use counts/hashes rather than silently truncating the path list.
	const fullOverview = { paths: context.paths, files: context.paths.length };
	const overview =
		estimateTextTokens(JSON.stringify(fullOverview)) < budget / 8
			? fullOverview
			: {
					files: context.paths.length,
					modules: [...modules].slice(0, 100),
					moduleCount: modules.size,
					manifestSha256: createHash("sha256").update(JSON.stringify(context.paths)).digest("hex"),
				};
	const history = context.history.slice(0, Math.max(256, Math.floor(budget / 8)));
	const parts = splitDiff(context, Math.max(128, Math.floor(budget / 5)));
	const originals = new Map(parts.map((part) => [part.id, part]));
	let sequence = 0;
	const batch = <T>(items: T[], build: (items: T[]) => unknown): T[][] => {
		const groups: T[][] = [];
		let current: T[] = [];
		for (const item of items) {
			if (!fits(build([...current, item]))) {
				if (!current.length) throw new Error("A commit analysis item cannot fit the model input budget.");
				groups.push(current);
				current = [];
			}
			if (!fits(build([item]))) throw new Error("A commit analysis item cannot fit the model input budget.");
			current.push(item);
		}
		if (current.length) groups.push(current);
		return groups;
	};
	const analyze = async (input: unknown, expected: string[], allowed: Set<string>): Promise<Analysis> => {
		const result = JSON.parse(await ask(input)) as Omit<Analysis, "id">;
		if (
			!result ||
			!Array.isArray(result.covered) ||
			JSON.stringify([...result.covered].sort()) !== JSON.stringify([...expected].sort()) ||
			!Array.isArray(result.features) ||
			!result.features.length ||
			!Array.isArray(result.uncertainties) ||
			!result.uncertainties.every((text) => typeof text === "string") ||
			!result.features.every(
				(feature) =>
					typeof feature.description === "string" &&
					feature.description.trim() &&
					Array.isArray(feature.sources) &&
					feature.sources.length &&
					feature.sources.every((id) => allowed.has(id)),
			)
		) {
			throw new Error("Commit analysis omitted evidence or returned invalid references.");
		}
		const represented = new Set(result.features.flatMap((feature) => feature.sources));
		if ([...allowed].some((id) => !represented.has(id))) {
			throw new Error("Commit analysis dropped a diff source.");
		}
		return { id: `summary-${++sequence}`, ...result };
	};
	const buildAnalysis = (chunks: DiffPart[], related: Analysis[] = []) => ({
		stage: "analyze",
		overview,
		history,
		chunks,
		related,
	});
	const groups = batch(parts, (chunks) => buildAnalysis(chunks));
	let summaries: Analysis[] = [];
	for (const [index, chunks] of groups.entries()) {
		options.onProgress?.(`正在分析提交改动（${index + 1}/${groups.length}）`);
		summaries.push(
			await analyze(
				buildAnalysis(chunks),
				chunks.map((part) => part.id),
				new Set(chunks.map((part) => part.id)),
			),
		);
	}
	const compact = async (records: Analysis[]): Promise<Analysis[]> => {
		let current = records;
		while (!fits({ stage: "synthesize", overview, history, summaries: current })) {
			const build = (summaries: Analysis[]) => ({ stage: "merge", overview, history, summaries });
			const groups = batch(current, build);
			options.onProgress?.("正在合并跨文件功能摘要");
			const next: Analysis[] = [];
			for (const group of groups) {
				const allowed = new Set(group.flatMap((record) => record.features.flatMap((feature) => feature.sources)));
				next.push(
					await analyze(
						build(group),
						group.map((record) => record.id),
						allowed,
					),
				);
			}
			if (estimateTextTokens(JSON.stringify(next)) >= estimateTextTokens(JSON.stringify(current))) {
				throw new Error("Commit summaries did not shrink enough to fit; no commit was created.");
			}
			current = next;
		}
		return current;
	};
	for (let round = 0; round < 3; round++) {
		summaries = await compact(summaries);
		options.onProgress?.("正在核对关联并汇总提交说明");
		const text = await ask({ stage: "synthesize", overview, history, summaries });
		const response = JSON.parse(text) as { read?: unknown };
		if (!response.read) return text;
		if (
			!Array.isArray(response.read) ||
			!response.read.length ||
			!response.read.every((id) => typeof id === "string" && originals.has(id))
		) {
			throw new Error("Commit synthesis requested invalid diff references.");
		}
		if (round === 2) throw new Error("Commit cross-file verification did not converge; no commit was created.");
		const requested = [...new Set(response.read as string[])].map((id) => originals.get(id)!);
		// Reconcile against raw evidence, not only the previous summaries. Keep each request bounded.
		for (const group of batch(requested, (chunks) => buildAnalysis(chunks))) {
			const related = summaries.filter((record) =>
				record.features.some((feature) => feature.sources.some((id) => group.some((chunk) => chunk.id === id))),
			);
			const input = buildAnalysis(group, related);
			const verified = await analyze(
				fits(input) ? input : buildAnalysis(group),
				group.map((part) => part.id),
				new Set(group.map((part) => part.id)),
			);
			summaries.push(verified);
		}
	}
	throw new Error("Commit description generation did not complete.");
}

export async function generateAICommitMessage(
	context: CommitMessageContext,
	complete: (systemPrompt: string, input: string) => Promise<string>,
	options: CommitAnalysisOptions = {},
): Promise<GeneratedCommitMessage> {
	const prompt = loadSystemPrompt("tasks/commit-message.md");
	if (!prompt.trim()) throw new Error("Commit description prompt is unavailable.");
	const text = await describeInBatches(context, prompt, complete, options);
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object") throw new Error("Invalid generated commit description.");
	const { title, body } = value as { title?: unknown; body?: unknown };
	if (
		typeof title !== "string" ||
		!title.trim() ||
		/[\r\n\0]/u.test(title) ||
		title.length > 200 ||
		!Array.isArray(body) ||
		body.length === 0 ||
		!body.every((line) => typeof line === "string" && !/[\r\n\0]/u.test(line)) ||
		!body.some((line) => line.trim())
	)
		throw new Error("Invalid generated commit title or body.");
	const full = [title.trim(), "", ...body].join("\n").trim();
	// Generated trailers must not replace Git's normal author or attribute the change to an AI.
	if (
		/co-authored-by\s*:|signed-off-by\s*:|generated\s+(?:by|with)|(?:AI|assistant|model)[- ](?:author|attribution|signature)\s*:|🤖/iu.test(
			full,
		) ||
		full.length > 30_000
	) {
		throw new Error("Generated commit description contains attribution or is too large.");
	}
	return { title: title.trim(), body, full };
}
