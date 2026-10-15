/**
 * Contract between the multi-agent dispatch tools (`agent`, `workflow`, `ultracode`) and the session that owns their
 * sub-agents. A tool registers every dispatch it starts; the session then knows what is running, can stop a single
 * task or the whole dispatch, and can move a dispatch that runs inside a tool call to the background when the main
 * run is interrupted (instead of cancelling it together with the run).
 *
 * The tools only depend on this interface; the session implements it (agent/delegation/background-work.ts).
 */

import type { SubAgentTaskSpec, SubAgentToolDetails } from "./sub-agent.ts";

export type DispatchSource = "agent" | "workflow" | "ultracode";

/** Progress details of one dispatch: an Explore batch (`results`) or a workflow (`phases`). */
export type DispatchDetails = SubAgentToolDetails | DispatchWorkflowDetails;

/** Structural view of WorkflowToolDetails (workflow/engine.ts) so this contract does not import the engine. */
export interface DispatchWorkflowDetails {
	name: string;
	status: string;
	activePhase: number;
	model?: string;
	batchId?: string;
	phases: Array<{
		name: string;
		status: string;
		completed: number;
		total: number;
		results: SubAgentToolDetails["results"];
	}>;
}

/** One task of a dispatch: the index in the batch, plus the phase for a workflow. */
export interface DispatchTaskRef {
	phase?: number;
	task: number;
}

export interface DispatchStart {
	source: DispatchSource;
	toolCallId?: string;
	/** Workflow name; Explore batches have none. */
	name?: string;
	/** Initial task list of an Explore batch, so it can be described before its first progress. */
	tasks?: SubAgentTaskSpec[];
}

/** How a dispatch that finished in the background is handed back to the main agent. */
export interface DispatchBackgroundOutcome {
	status: "completed" | "partial" | "failed";
	text: string;
	fullText?: string;
	details?: DispatchDetails;
}

export interface DispatchHandle {
	/** Registry id; also carried as `batchId` in the dispatch details. */
	readonly id: string;
	/** Aborted when the whole dispatch must end at once (stop button, session disposal). */
	readonly signal: AbortSignal;
	/** Resolves when the session moved this dispatch to the background (the main run was interrupted). */
	readonly detached: Promise<void>;
	readonly isDetached: boolean;
	/** End the whole dispatch at once (aborts `signal`); its outcome is not delivered to the model. */
	abort(): void;
	/** The tool's own way to stop one task (and, for a workflow, the whole run without aborting `signal`). */
	setControls(controls: { killTask?: (ref: DispatchTaskRef) => void; killAll?: () => void }): void;
	progress(details: DispatchDetails): void;
	/** A note for the tool result when the user stopped tasks from the panel, so the model does not redispatch them. */
	stopNote(): string | undefined;
	/** The dispatch finished inside its tool call; its result reached the model through the tool result. */
	finishForeground(details?: DispatchDetails): void;
	/** The dispatch was moved to the background: deliver its outcome when it settles (unless it was stopped). */
	completeInBackground(outcome: Promise<DispatchBackgroundOutcome>): void;
}

export interface DispatchRegistrar {
	begin(start: DispatchStart): DispatchHandle;
}

/**
 * Wait for a dispatch that runs inside a tool call, honouring the session's controls: the run being aborted without
 * a detach stops the work (it belongs to the run, as before); a detach returns at once and leaves the work running.
 */
export async function awaitForegroundDispatch<T>(
	handle: DispatchHandle,
	work: Promise<T>,
	toolSignal: AbortSignal | undefined,
): Promise<{ kind: "done"; value: T } | { kind: "detached" }> {
	const onToolAbort = () => {
		if (!handle.isDetached) handle.abort();
	};
	if (toolSignal?.aborted) onToolAbort();
	else toolSignal?.addEventListener("abort", onToolAbort, { once: true });
	try {
		return await Promise.race([
			work.then((value) => ({ kind: "done" as const, value })),
			handle.detached.then(() => ({ kind: "detached" as const })),
		]);
	} finally {
		toolSignal?.removeEventListener("abort", onToolAbort);
	}
}
