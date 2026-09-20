/**
 * A cancellation can arrive after the filesystem has committed a mutation.
 * Keeping this fact in tool details prevents the agent loop from treating a
 * successful write as a failed tool call and retrying it.
 */
export type FileMutationDetails = {
	mutationStatus: "committed-after-cancel";
};

export function committedAfterCancel(signal: AbortSignal | undefined): FileMutationDetails | undefined {
	return signal?.aborted ? { mutationStatus: "committed-after-cancel" } : undefined;
}
