/** A workflow that is configured to run for an ordinary branch push. */
export interface GitPushWorkflowDefinition {
	path: string;
	name: string;
}

export interface GitPushCiTarget {
	owner: string;
	repository: string;
	branch: string;
	commitSha: string;
}

export interface GitPushCiRun {
	id: number;
	workflowId?: number;
	workflowName: string;
	workflowPath?: string;
	event: string;
	branch?: string;
	headSha: string;
	status: string;
	conclusion?: string;
	htmlUrl?: string;
	createdAt?: string;
	updatedAt?: string;
	runNumber?: number;
}

export interface GitPushCiStep {
	number?: number;
	name: string;
	status?: string;
	conclusion?: string;
	startedAt?: string;
	completedAt?: string;
}

export interface GitPushCiJob {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	startedAt?: string;
	completedAt?: string;
	steps: GitPushCiStep[];
	log?: string;
}

export interface GitPushCiFailureEvidence {
	run: GitPushCiRun;
	jobs: GitPushCiJob[];
	/** The local provider may not be able to download logs; this records why. */
	logWarnings?: string[];
}

export interface GitPushCiProvider {
	listRuns(target: GitPushCiTarget, signal: AbortSignal): Promise<readonly GitPushCiRun[]>;
	getFailureEvidence(
		run: GitPushCiRun,
		target: GitPushCiTarget,
		signal: AbortSignal,
	): Promise<GitPushCiFailureEvidence>;
	/** At most one bounded retry is requested by the push workflow. */
	rerunFailedJobs?(run: GitPushCiRun, target: GitPushCiTarget, signal: AbortSignal): Promise<void>;
}

export type GitPushCiFailureCategory =
	| "code"
	| "test"
	| "windows-compatibility"
	| "path-shell-line-ending"
	| "workflow"
	| "permission"
	| "flaky"
	| "infrastructure"
	| "external-service"
	| "unknown";

export interface GitPushCiFailure {
	evidence: GitPushCiFailureEvidence;
	category: GitPushCiFailureCategory;
	/** True only when the evidence supports an automatic code-fix turn. */
	autoRepairable: boolean;
}
