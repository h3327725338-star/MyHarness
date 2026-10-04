// Labels describe the server's actual phase, not optional features that might be disabled.
export const COMPLETION_DELAY_MS = 500;

export function completionLabel(status) {
	switch (status?.phase) {
		case "changes": return "Checking this task's file changes";
		case "records": return "Saving task records";
		case "memory": return "Organizing long-term memory";
		default: return "Finalizing task records";
	}
}

export function completionDelay(status, now = Date.now()) {
	return Math.max(0, COMPLETION_DELAY_MS - Math.max(0, now - status.startedAt));
}
