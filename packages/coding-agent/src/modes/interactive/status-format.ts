/** Shared time formatting for persistent and transient interactive status. */
export function formatDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function formatRecentActivity(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	if (totalSeconds < 1) return "刚刚";
	if (totalSeconds < 60) return `${totalSeconds}s 前`;
	return `${Math.floor(totalSeconds / 60)}m 前`;
}
