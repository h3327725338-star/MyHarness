import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import { AccountConnections } from "../../providers/credentials/account-connections.ts";
import { parseGitUrl } from "../repository/source.ts";
import type {
	GitPushCiFailureEvidence,
	GitPushCiJob,
	GitPushCiProvider,
	GitPushCiRun,
	GitPushCiStep,
	GitPushCiTarget,
	GitPushWorkflowDefinition,
} from "./types.ts";

export interface GitHubRepositoryReference {
	owner: string;
	repository: string;
}

export interface GitPushWorkflowDiscovery {
	workflows: GitPushWorkflowDefinition[];
	errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function getWorkflowOn(document: Record<string, unknown>): unknown {
	// YAML 1.1 parsers may expose the `on` key as boolean true.
	return document.on ?? document.true;
}

function branchMatches(branch: string, patterns: unknown): boolean {
	if (!Array.isArray(patterns) || patterns.length === 0) return true;
	const values = patterns.filter((pattern): pattern is string => typeof pattern === "string");
	const positives = values.filter((pattern) => !pattern.startsWith("!"));
	const negatives = values.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	if (positives.length > 0 && !positives.some((pattern) => minimatch(branch, pattern))) return false;
	return !negatives.some((pattern) => minimatch(branch, pattern));
}

function pushTriggerMatchesBranch(pushConfig: unknown, branch: string): boolean {
	if (pushConfig === undefined) return false;
	if (pushConfig === null || pushConfig === true || pushConfig === "") return true;
	if (typeof pushConfig === "string") return pushConfig === "push";
	if (Array.isArray(pushConfig)) return true;
	if (!isRecord(pushConfig)) return false;

	// A tags-only push trigger is not a branch-push workflow. A config with
	// paths/paths-ignore but no ref filters applies to all branches.
	if (pushConfig.branches === undefined && pushConfig["branches-ignore"] === undefined) {
		if (pushConfig.tags !== undefined || pushConfig["tags-ignore"] !== undefined) return false;
		return true;
	}
	if (!branchMatches(branch, pushConfig.branches)) return false;
	const ignored = pushConfig["branches-ignore"];
	return (
		!Array.isArray(ignored) || !ignored.some((pattern) => typeof pattern === "string" && minimatch(branch, pattern))
	);
}

/** Read only the repository's own workflow declarations; never guesses a CI runner. */
export async function discoverPushWorkflows(repositoryRoot: string, branch: string): Promise<GitPushWorkflowDiscovery> {
	const directory = path.join(repositoryRoot, ".github", "workflows");
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return { workflows: [], errors: [] };
	}

	const workflows: GitPushWorkflowDefinition[] = [];
	const errors: string[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isFile() || !/\.(?:yml|yaml)$/iu.test(entry.name)) continue;
		const workflowPath = path.posix.join(".github", "workflows", entry.name);
		const absolutePath = path.join(directory, entry.name);
		try {
			const document = parseYaml(await readFile(absolutePath, "utf8")) as unknown;
			if (!isRecord(document)) continue;
			const trigger = getWorkflowOn(document);
			let pushConfig: unknown;
			if (Array.isArray(trigger)) {
				pushConfig = trigger.includes("push") ? true : undefined;
			} else if (trigger === "push") {
				pushConfig = true;
			} else if (isRecord(trigger)) {
				pushConfig = trigger.push;
			}
			if (!pushTriggerMatchesBranch(pushConfig, branch)) continue;
			if (!isRecord(document.jobs) || Object.keys(document.jobs).length === 0) continue;
			workflows.push({
				path: workflowPath,
				name: stringValue(document.name) ?? entry.name.replace(/\.(?:yml|yaml)$/iu, ""),
			});
		} catch (error) {
			errors.push(`${workflowPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { workflows, errors };
}

function parseRun(value: unknown): GitPushCiRun | undefined {
	if (!isRecord(value)) return undefined;
	const id = numberValue(value.id);
	const headSha = stringValue(value.head_sha);
	const workflowName = stringValue(value.name);
	const event = stringValue(value.event);
	const status = stringValue(value.status);
	if (id === undefined || !headSha || !workflowName || !event || !status) return undefined;
	return {
		id,
		workflowId: numberValue(value.workflow_id),
		workflowName,
		workflowPath: stringValue(value.path),
		event,
		branch: stringValue(value.head_branch),
		headSha,
		status,
		conclusion: stringValue(value.conclusion),
		htmlUrl: stringValue(value.html_url),
		createdAt: stringValue(value.created_at),
		updatedAt: stringValue(value.updated_at),
		runNumber: numberValue(value.run_number),
	};
}

function parseStep(value: unknown): GitPushCiStep | undefined {
	if (!isRecord(value)) return undefined;
	const name = stringValue(value.name);
	if (!name) return undefined;
	return {
		number: numberValue(value.number),
		name,
		status: stringValue(value.status),
		conclusion: stringValue(value.conclusion),
		startedAt: stringValue(value.started_at),
		completedAt: stringValue(value.completed_at),
	};
}

function parseJob(value: unknown): GitPushCiJob | undefined {
	if (!isRecord(value)) return undefined;
	const id = numberValue(value.id);
	const name = stringValue(value.name);
	if (id === undefined || !name) return undefined;
	const steps = Array.isArray(value.steps)
		? value.steps.map(parseStep).filter((step): step is GitPushCiStep => step !== undefined)
		: [];
	return {
		id,
		name,
		status: stringValue(value.status),
		conclusion: stringValue(value.conclusion),
		startedAt: stringValue(value.started_at),
		completedAt: stringValue(value.completed_at),
		steps,
	};
}

function apiRepoPath(reference: GitHubRepositoryReference): string {
	return `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}`;
}

export function parseGitHubRepository(remoteUrl: string): GitHubRepositoryReference | undefined {
	const source = parseGitUrl(remoteUrl);
	if (!source || source.host.toLowerCase() !== "github.com") return undefined;
	const segments = source.path.split("/").filter(Boolean);
	if (segments.length !== 2) return undefined;
	const [owner, repository] = segments;
	if (!owner || !repository || !/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repository)) {
		return undefined;
	}
	return { owner, repository };
}

export class GitHubActionsCiProvider implements GitPushCiProvider {
	private readonly connections: AccountConnections;
	private readonly repository: GitHubRepositoryReference;

	constructor(repository: GitHubRepositoryReference, connections = new AccountConnections()) {
		this.repository = repository;
		this.connections = connections;
	}

	async listRuns(target: GitPushCiTarget, signal: AbortSignal): Promise<readonly GitPushCiRun[]> {
		const query = new URLSearchParams({
			head_sha: target.commitSha,
			event: "push",
			branch: target.branch,
			per_page: "100",
		});
		const result = await this.connections.api(
			`${apiRepoPath(this.repository)}/actions/runs?${query.toString()}`,
			"GET",
			undefined,
			signal,
		);
		const data = isRecord(result.data) ? result.data.workflow_runs : undefined;
		return Array.isArray(data) ? data.map(parseRun).filter((run): run is GitPushCiRun => run !== undefined) : [];
	}

	async getFailureEvidence(
		run: GitPushCiRun,
		_target: GitPushCiTarget,
		signal: AbortSignal,
	): Promise<GitPushCiFailureEvidence> {
		const jobs: GitPushCiJob[] = [];
		const logWarnings: string[] = [];
		let next: string | undefined =
			`${apiRepoPath(this.repository)}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`;
		while (next) {
			const result = await this.connections.api(next, "GET", undefined, signal);
			const data = isRecord(result.data) ? result.data.jobs : undefined;
			if (Array.isArray(data)) {
				for (const rawJob of data) {
					const job = parseJob(rawJob);
					if (job) jobs.push(job);
				}
			}
			next = result.next;
		}

		for (const job of jobs.filter((candidate) => candidate.conclusion !== "success")) {
			try {
				const log = await this.connections.apiText(
					`${apiRepoPath(this.repository)}/actions/jobs/${job.id}/logs`,
					signal,
				);
				job.log = log.length > 30_000 ? `${log.slice(0, 15_000)}\n…\n${log.slice(-15_000)}` : log;
			} catch (error) {
				logWarnings.push(
					`无法读取 job ${job.name} 的日志：${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return { run, jobs, ...(logWarnings.length > 0 ? { logWarnings } : {}) };
	}

	async rerunFailedJobs(run: GitPushCiRun, _target: GitPushCiTarget, signal: AbortSignal): Promise<void> {
		await this.connections.api(
			`${apiRepoPath(this.repository)}/actions/runs/${run.id}/rerun-failed-jobs`,
			"POST",
			undefined,
			signal,
		);
	}
}
