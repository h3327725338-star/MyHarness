/**
 * High-level lifecycle for the user task shown by InteractiveMode.
 *
 * AgentSession.isStreaming remains an agent-execution signal. This module
 * deliberately derives a separate UI/task signal from the existing
 * InteractiveMode workflow state instead of changing that core meaning.
 */
export type TaskLifecyclePhase = "idle" | "main_agent" | "completion" | "awaiting_decision";

export interface TaskLifecycleInputs {
	/** Whether the outer Agent run is still active according to RunState. */
	agentIsActive?: boolean;
	/** Compatibility fallback for hosts that only expose the current stream state. */
	agentIsStreaming?: boolean;
	/** Whether the post-Agent completion workflow is still active. */
	completionWorkflowActive: boolean;
	/** Whether a completion workflow promise still exists. */
	completionWorkflowPending: boolean;
	/** Whether a Save/Restore-style user decision control is currently open. */
	taskDecisionActive: boolean;
}

/**
 * Derive the one high-level task phase used by InteractiveMode UI decisions.
 * Decision prompts have highest priority so they are never rendered as busy.
 */
export function deriveTaskLifecyclePhase(inputs: TaskLifecycleInputs): TaskLifecyclePhase {
	if (inputs.taskDecisionActive) return "awaiting_decision";
	if (inputs.completionWorkflowActive || inputs.completionWorkflowPending) return "completion";
	if (inputs.agentIsActive ?? inputs.agentIsStreaming ?? false) return "main_agent";
	return "idle";
}

export function isTaskLifecycleBusy(phase: TaskLifecyclePhase): boolean {
	return phase === "main_agent" || phase === "completion";
}
