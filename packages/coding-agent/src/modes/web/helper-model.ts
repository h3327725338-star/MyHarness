/** The model a one-shot helper request of the Web UI runs on (commit description, worktree naming, translation). */

import type { ThinkingLevel } from "@myharness/agent-core";
import { clampThinkingLevel } from "@myharness/ai";
import type { Model } from "@myharness/ai/compat";
import { resolveAssistantModel } from "../../agent/runtime/assistant-model.ts";
import type { WebHost } from "./host.ts";
import { HttpError } from "./http-server.ts";

/** Helper-model reference stored in settings: empty provider/model means "use the main model". */
export interface HelperModelRef {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Resolve the model a helper (commit description, worktree naming, selection translation) runs on.
 * Default (no provider/model) follows the main chat model and effort, exactly like before;
 * an explicit provider+model uses its own effort (the model's highest when the level is left empty).
 * A half-filled reference (only one of the two set) is treated as not configured.
 */
export function resolveHelperModel(
	host: WebHost,
	configured: HelperModelRef,
	notConfiguredError: string,
): { model: Model<any>; thinkingLevel: ThinkingLevel } {
	const mainModel = host.session.model as Model<any> | undefined;
	if (!mainModel) throw new HttpError(400, notConfiguredError);
	const mainRef = { provider: mainModel.provider, id: mainModel.id, thinkingLevel: host.session.thinkingLevel };
	if (!configured.provider && !configured.model) {
		const level = (configured.thinkingLevel ?? mainRef.thinkingLevel) as ThinkingLevel;
		return { model: mainModel, thinkingLevel: clampThinkingLevel(mainModel, level) as ThinkingLevel };
	}
	if (!configured.provider || !configured.model) {
		const level = (configured.thinkingLevel ?? mainRef.thinkingLevel) as ThinkingLevel;
		return { model: mainModel, thinkingLevel: clampThinkingLevel(mainModel, level) as ThinkingLevel };
	}
	const ref = resolveAssistantModel(configured, mainRef);
	const selected =
		ref && host.session.modelRuntime.isProviderEnabled(ref.provider)
			? host.session.modelRuntime.getModel(ref.provider, ref.model)
			: undefined;
	if (!selected) throw new HttpError(400, `Helper model unavailable: ${configured.provider}/${configured.model}`);
	return { model: selected, thinkingLevel: clampThinkingLevel(selected, ref!.thinkingLevel) as ThinkingLevel };
}

/** Reasoning option for one-shot completions: 'off' sends nothing. */
export function reasoningOf(thinkingLevel: ThinkingLevel) {
	return thinkingLevel === "off" ? undefined : thinkingLevel;
}
