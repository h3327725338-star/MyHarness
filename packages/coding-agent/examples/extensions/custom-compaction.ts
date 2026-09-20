/** Compaction lifecycle notifications. Configure Compact Model and Thinking Effort in Settings. */
import type { ExtensionAPI } from "@myharness/coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		ctx.ui.notify(`Compacting ${event.preparation.messagesToSummarize.length} messages`, "info");
	});
	pi.on("session_compact", async (_event, ctx) => {
		ctx.ui.notify("Context checkpoint saved", "info");
	});
}
