/**
 * 提交信息自动生成（Git Commit Message Generation）。
 *
 * 基于真实的 git diff（name-status / numstat / 内容扫描）生成准确、详细的
 * conventional commits 风格提交信息，替代固定文案（如 "Auto Review 任务修改"）。
 *
 * 原则：只使用真实数据（文件路径、变更状态、行数、diff 中实际出现的符号/文本），
 * 不编造任何改动内容。无法可靠推断时使用保守的通用摘要。
 */

import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { runGit, runGitAsync } from "../repository/integration.ts";

export interface GeneratedCommitMessage {
	/** 标题行（conventional commits 风格：type(scope): summary） */
	title: string;
	/** 正文行（文件级清单，含符号级变更要点） */
	body: string[];
	/** 完整提交信息（标题 + 空行 + 正文） */
	full: string;
}

interface FileChange {
	status: "A" | "M" | "D";
	path: string;
	added: number;
	deleted: number;
	/** 从 diff 内容中提取的变更符号/要点（真实出现于 +/- 行） */
	points: string[];
}

const TEST_PATH_PATTERN = /(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z0-9]+$/i;
const DOC_PATH_PATTERN = /(^|\/)(docs?|examples?)(\/|$)|\.(md|markdown)$/i;
const FIX_PATTERN = /(修复|修正|解决|bug\s*fix|hotfix)/i;

/** diff 内容扫描的最大字节数（超过则跳过符号提取，只保留统计） */
const MAX_DIFF_SCAN_BYTES = 300 * 1024;
/** 每个文件最多提取的变更要点数 */
const MAX_POINTS_PER_FILE = 4;
/** 全部文件最多提取的变更要点总数 */
const MAX_POINTS_TOTAL = 24;

function isBinaryNumstat(token: string): boolean {
	return token === "-";
}

/**
 * 从行集合中提取真实出现的变更要点（函数/类/接口/类型/常量定义名、中文动作短语）。
 */
function extractPointsFromLines(lines: Iterable<string>): string[] {
	const points: string[] = [];
	const seen = new Set<string>();
	const push = (text: string) => {
		const normalized = text.trim().replace(/^[+-]\s*/, "");
		if (!normalized || normalized.length > 80) return;
		if (seen.has(normalized)) return;
		seen.add(normalized);
		points.push(normalized);
	};
	for (const rawLine of lines) {
		const content = rawLine.startsWith("+") ? rawLine.slice(1) : rawLine;
		if (points.length >= MAX_POINTS_PER_FILE) break;
		const symbolMatch =
			content.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/) ||
			content.match(/\bclass\s+([A-Za-z_$][\w$]*)/) ||
			content.match(/\binterface\s+([A-Za-z_$][\w$]*)/) ||
			content.match(/\btype\s+([A-Za-z_$][\w$]*)\s*=/);
		if (symbolMatch) {
			push(`${symbolMatch[1]}()`);
			continue;
		}
		const methodMatch = content.match(/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^=;{]+)?\s*\{/);
		if (methodMatch && !/^(if|for|while|switch|catch|function)$/.test(methodMatch[1])) {
			push(`${methodMatch[1]}()`);
			continue;
		}
		const constMatch = content.match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/);
		if (constMatch) {
			push(`${constMatch[1]}`);
			continue;
		}
		const actionMatch = content.match(/^\s*(?:新增|修复|修正|更新|删除|重构|调整|优化)[^，。；\n]{1,24}/);
		if (actionMatch) {
			push(actionMatch[0].trim());
		}
	}
	return points.slice(0, MAX_POINTS_PER_FILE);
}

/**
 * 从 diff 文本的 +/- 行中提取变更要点。
 */
function extractChangePoints(diffText: string): string[] {
	const lines: string[] = [];
	for (const line of diffText.split(/\r?\n/)) {
		if (line.startsWith("+") && !line.startsWith("+++")) lines.push(line);
	}
	return extractPointsFromLines(lines);
}

function parseNumstat(stdout: string, statusByPath: Map<string, "A" | "M" | "D">): FileChange[] {
	const changes: FileChange[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const [addedToken, deletedToken, rawPath] = parts;
		if (isBinaryNumstat(addedToken) || isBinaryNumstat(deletedToken)) {
			changes.push({ status: "M", path: rawPath, added: 0, deleted: 0, points: [] });
			continue;
		}
		const added = Number(addedToken);
		const deleted = Number(deletedToken);
		const path = rawPath.replace(/^"|"$/g, "");
		const status =
			statusByPath.get(path) ?? (added === 0 && deleted > 0 ? "D" : added > 0 && deleted === 0 ? "A" : "M");
		changes.push({ status, path, added, deleted, points: [] });
	}
	return changes;
}

function inferType(changes: FileChange[], diffText: string): string {
	if (changes.length === 0) return "chore";
	const testFiles = changes.filter((change) => TEST_PATH_PATTERN.test(change.path));
	const docFiles = changes.filter((change) => DOC_PATH_PATTERN.test(change.path));
	if (testFiles.length / changes.length >= 0.5) return "test";
	if (docFiles.length / changes.length >= 0.5) return "docs";
	if (FIX_PATTERN.test(diffText)) return "fix";
	const addedFiles = changes.filter((change) => change.status === "A").length;
	if (addedFiles >= Math.ceil(changes.length / 2)) return "feat";
	const totalAdded = changes.reduce((sum, change) => sum + change.added, 0);
	const totalDeleted = changes.reduce((sum, change) => sum + change.deleted, 0);
	if (totalDeleted > totalAdded * 3 && totalDeleted > 50) return "refactor";
	return "chore";
}

function inferScope(changes: FileChange[]): string | undefined {
	const scopes = new Set<string>();
	for (const change of changes) {
		const parts = change.path.split("/");
		if (parts[0] === "packages" && parts[1]) scopes.add(parts[1]);
		else if (parts[0] === "scripts" || parts[0] === "docs" || parts[0] === "examples") scopes.add(parts[0]);
		else if (parts.length === 1) scopes.add("root");
		else scopes.add(parts[0]);
	}
	if (scopes.size === 1) {
		const scope = [...scopes][0];
		return scope === "root" ? undefined : scope;
	}
	return undefined;
}

function buildTitle(type: string, scope: string | undefined, changes: FileChange[]): string {
	const hasAdded = changes.some((change) => change.status === "A");
	const hasOther = changes.some((change) => change.status !== "A");
	const verb =
		type === "feat"
			? hasAdded && !hasOther
				? "新增"
				: "更新"
			: type === "fix"
				? "修复"
				: type === "test"
					? "补充测试"
					: type === "docs"
						? "更新文档"
						: "更新";
	const scopePart = scope ? `(${scope})` : "";
	if (changes.length === 1) {
		const fileName = changes[0].path.split("/").pop() ?? changes[0].path;
		const name = fileName.replace(/\.[a-z0-9]+$/i, "");
		return `${type}${scopePart}: ${verb} ${name}`;
	}
	const target = scope ?? "项目";
	return `${type}${scopePart}: ${verb} ${target}（${changes.length} 个文件）`;
}

/**
 * 异步版 generateCommitMessageForPaths：基于真实 git diff 生成提交信息，
 * git 命令并行异步执行，不阻塞事件循环（供后台提交任务使用）。
 */
export async function generateCommitMessageForPathsAsync(
	repositoryRoot: string,
	paths: string[],
	signal?: AbortSignal,
): Promise<GeneratedCommitMessage> {
	const filter = paths.length > 0 ? ["--", ...paths] : [];
	const [nameStatusResult, numstatResult, untrackedResult, diffResult] = await Promise.all([
		runGitAsync(repositoryRoot, ["diff", "--name-status", "HEAD", ...filter], undefined, signal),
		runGitAsync(repositoryRoot, ["diff", "--numstat", "HEAD", ...filter], undefined, signal),
		runGitAsync(repositoryRoot, ["ls-files", "--others", "--exclude-standard", ...filter], undefined, signal),
		runGitAsync(repositoryRoot, ["diff", "HEAD", ...filter], undefined, signal),
	]);

	const statusByPath = new Map<string, "A" | "M" | "D">();
	if (nameStatusResult.ok) {
		for (const line of nameStatusResult.stdout.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const match = line.match(/^([AMD])\s+(.+)$/);
			if (match) statusByPath.set(match[2].replace(/^"|"$/g, ""), match[1] as "A" | "M" | "D");
		}
	}
	let changes: FileChange[] = [];
	if (numstatResult.ok) {
		changes = parseNumstat(numstatResult.stdout, statusByPath);
	}
	if (changes.length === 0 && nameStatusResult.ok) {
		// 二进制或解析失败时退化为 name-status 列表
		changes = [...statusByPath.entries()].map(([path, status]) => ({
			status,
			path,
			added: 0,
			deleted: 0,
			points: [],
		}));
	}

	// 未暂存的新文件（untracked）不在 git diff 中，单独收集并统计行数。
	if (untrackedResult.ok) {
		for (const line of untrackedResult.stdout.split(/\r?\n/)) {
			const path = line.trim();
			if (!path || changes.some((change) => change.path === path)) continue;
			let added = 0;
			let points: string[] = [];
			try {
				const fileStats = await stat(join(repositoryRoot, path));
				if (fileStats.isFile() && fileStats.size <= 1024 * 1024) {
					const content = await readFile(join(repositoryRoot, path), "utf8");
					added = content.split(/\r?\n/).filter(Boolean).length;
					points = extractPointsFromLines(content.split(/\r?\n/).slice(0, 200));
				}
			} catch {
				// 无法读取（目录/权限/大小超限）时不统计行数。
			}
			changes.push({ status: "A", path, added, deleted: 0, points });
		}
	}

	// 内容扫描：提取真实变更要点（限定大小，防止超大 diff 拖慢提交）
	let diffText = "";
	if (diffResult.ok && Buffer.byteLength(diffResult.stdout, "utf8") <= MAX_DIFF_SCAN_BYTES) {
		diffText = diffResult.stdout;
	}
	if (diffText.length > 0) {
		const fileHunks = diffText.split(/^diff --git /m).slice(1);
		const pointsByPath = new Map<string, string[]>();
		for (const hunk of fileHunks) {
			const pathMatch = hunk.match(/^a\/(.+?)\s+b\//);
			if (!pathMatch) continue;
			const filePath = pathMatch[1].replace(/^"|"$/g, "");
			pointsByPath.set(filePath, extractChangePoints(hunk));
		}
		let totalPoints = 0;
		for (const change of changes) {
			const points = pointsByPath.get(change.path)!;
			if (!points) continue;
			const remaining = MAX_POINTS_TOTAL - totalPoints;
			change.points = points.slice(0, Math.max(0, Math.min(remaining, MAX_POINTS_PER_FILE)));
			totalPoints += change.points.length;
			if (totalPoints >= MAX_POINTS_TOTAL) break;
		}
	}

	const type = inferType(changes, diffText);
	const scope = inferScope(changes);
	const title = buildTitle(type, scope, changes);
	const body: string[] = [];
	for (const change of changes) {
		const statText = change.added === 0 && change.deleted === 0 ? "" : ` (+${change.added}/-${change.deleted})`;
		body.push(`- ${change.status} ${change.path}${statText}`);
		for (const point of change.points) {
			body.push(`  - ${point}`);
		}
	}
	if (body.length === 0) body.push("- 无文件级变更统计（可能为二进制或重命名）");
	return { title, body, full: [title, "", ...body].join("\n") };
}

/**
 * 异步版 generateInitialCommitMessage：基于暂存区统计生成首次提交信息，
 * 不阻塞事件循环。
 */
export async function generateInitialCommitMessageAsync(
	repositoryRoot: string,
	signal?: AbortSignal,
): Promise<GeneratedCommitMessage> {
	const [nameStatusResult, numstatResult] = await Promise.all([
		runGitAsync(repositoryRoot, ["diff", "--cached", "--name-status"], undefined, signal),
		runGitAsync(repositoryRoot, ["diff", "--cached", "--numstat"], undefined, signal),
	]);
	const statusByPath = new Map<string, "A" | "M" | "D">();
	if (nameStatusResult.ok) {
		for (const line of nameStatusResult.stdout.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const match = line.match(/^([AMD])\s+(.+)$/);
			if (match) statusByPath.set(match[2].replace(/^"|"$/g, ""), match[1] as "A" | "M" | "D");
		}
	}
	let changes: FileChange[] = [];
	if (numstatResult.ok) {
		changes = parseNumstat(numstatResult.stdout, statusByPath);
	}
	const title = `chore: 建立项目初始版本（${changes.length} 个文件）`;
	const body = changes.slice(0, 100).map((change) => `- ${change.status} ${change.path}`);
	if (changes.length > 100) body.push(`- ……另有 ${changes.length - 100} 个文件`);
	return { title, body, full: [title, "", ...body].join("\n") };
}

/**
 * 为指定路径集合生成提交信息。
 *
 * @param repositoryRoot 仓库根目录
 * @param paths 待提交的路径（相对仓库根目录）
 */
export function generateCommitMessageForPaths(repositoryRoot: string, paths: string[]): GeneratedCommitMessage {
	const filter = paths.length > 0 ? ["--", ...paths] : [];
	const nameStatusResult = runGit(repositoryRoot, ["diff", "--name-status", "HEAD", ...filter]);
	const statusByPath = new Map<string, "A" | "M" | "D">();
	if (nameStatusResult.ok) {
		for (const line of nameStatusResult.stdout.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const match = line.match(/^([AMD])\s+(.+)$/);
			if (match) statusByPath.set(match[2].replace(/^"|"$/g, ""), match[1] as "A" | "M" | "D");
		}
	}
	const numstatResult = runGit(repositoryRoot, ["diff", "--numstat", "HEAD", ...filter]);
	let changes: FileChange[] = [];
	if (numstatResult.ok) {
		changes = parseNumstat(numstatResult.stdout, statusByPath);
	}
	if (changes.length === 0 && nameStatusResult.ok) {
		// 二进制或解析失败时退化为 name-status 列表
		changes = [...statusByPath.entries()].map(([path, status]) => ({
			status,
			path,
			added: 0,
			deleted: 0,
			points: [],
		}));
	}

	// 未暂存的新文件（untracked）不在 git diff 中，单独收集并统计行数。
	const untrackedResult = runGit(repositoryRoot, ["ls-files", "--others", "--exclude-standard", ...filter]);
	if (untrackedResult.ok) {
		for (const line of untrackedResult.stdout.split(/\r?\n/)) {
			const path = line.trim();
			if (!path || changes.some((change) => change.path === path)) continue;
			let added = 0;
			let points: string[] = [];
			try {
				const stats = statSync(join(repositoryRoot, path));
				if (stats.isFile() && stats.size <= 1024 * 1024) {
					const content = readFileSync(join(repositoryRoot, path), "utf8");
					added = content.split(/\r?\n/).filter(Boolean).length;
					points = extractPointsFromLines(content.split(/\r?\n/).slice(0, 200));
				}
			} catch {
				// 无法读取（目录/权限/大小超限）时不统计行数。
			}
			changes.push({ status: "A", path, added, deleted: 0, points });
		}
	}

	// 内容扫描：提取真实变更要点（限定大小，防止超大 diff 拖慢提交）
	let diffText = "";
	const diffResult = runGit(repositoryRoot, ["diff", "HEAD", ...filter]);
	if (diffResult.ok && Buffer.byteLength(diffResult.stdout, "utf8") <= MAX_DIFF_SCAN_BYTES) {
		diffText = diffResult.stdout;
	}
	if (diffText.length > 0) {
		const fileHunks = diffText.split(/^diff --git /m).slice(1);
		const pointsByPath = new Map<string, string[]>();
		for (const hunk of fileHunks) {
			const pathMatch = hunk.match(/^a\/(.+?)\s+b\//);
			if (!pathMatch) continue;
			const filePath = pathMatch[1].replace(/^"|"$/g, "");
			pointsByPath.set(filePath, extractChangePoints(hunk));
		}
		let totalPoints = 0;
		for (const change of changes) {
			const points = pointsByPath.get(change.path)!;
			if (!points) continue;
			const remaining = MAX_POINTS_TOTAL - totalPoints;
			change.points = points.slice(0, Math.max(0, Math.min(remaining, MAX_POINTS_PER_FILE)));
			totalPoints += change.points.length;
			if (totalPoints >= MAX_POINTS_TOTAL) break;
		}
	}

	const type = inferType(changes, diffText);
	const scope = inferScope(changes);
	const title = buildTitle(type, scope, changes);
	const body: string[] = [];
	for (const change of changes) {
		const stat = change.added === 0 && change.deleted === 0 ? "" : ` (+${change.added}/-${change.deleted})`;
		body.push(`- ${change.status} ${change.path}${stat}`);
		for (const point of change.points) {
			body.push(`  - ${point}`);
		}
	}
	if (body.length === 0) body.push("- 无文件级变更统计（可能为二进制或重命名）");
	return { title, body, full: [title, "", ...body].join("\n") };
}

/**
 * 为首次提交（初始版本，无 HEAD）生成提交信息。
 * 使用暂存区（git add 之后）的 name-status / numstat 统计。
 */
export function generateInitialCommitMessage(repositoryRoot: string): GeneratedCommitMessage {
	const nameStatusResult = runGit(repositoryRoot, ["diff", "--cached", "--name-status"]);
	const statusByPath = new Map<string, "A" | "M" | "D">();
	if (nameStatusResult.ok) {
		for (const line of nameStatusResult.stdout.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const match = line.match(/^([AMD])\s+(.+)$/);
			if (match) statusByPath.set(match[2].replace(/^"|"$/g, ""), match[1] as "A" | "M" | "D");
		}
	}
	const numstatResult = runGit(repositoryRoot, ["diff", "--cached", "--numstat"]);
	let changes: FileChange[] = [];
	if (numstatResult.ok) {
		changes = parseNumstat(numstatResult.stdout, statusByPath);
	}
	const title = `chore: 建立项目初始版本（${changes.length} 个文件）`;
	const body = changes.slice(0, 100).map((change) => `- ${change.status} ${change.path}`);
	if (changes.length > 100) body.push(`- ……另有 ${changes.length - 100} 个文件`);
	return { title, body, full: [title, "", ...body].join("\n") };
}
