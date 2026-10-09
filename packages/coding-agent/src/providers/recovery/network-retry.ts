/**
 * Retry policy for network failures (connect, first byte, stream idle, dropped connection).
 *
 * A network failure is retried on the same model a few times (`retry.networkMaxAttempts`, the first attempt included),
 * after which the fallback model takes over. Transient HTTP failures (429, overloaded, connection resets) are retried
 * on the `retry.maxRetries` session budget with `retry.baseDelayMs` exponential backoff, and the provider SDK receives
 * the same `retry.provider.*` settings the main Agent's stream function injects. `retry.enabled` gates all of it:
 * one-shot completions honor exactly the retry configuration the main Agent run uses, no second set of knobs.
 *
 * What was already shown to the person decides whether a retry is allowed: a failure before any output is retried from
 * scratch; a failure after output has started is never resent automatically (the run stops as interrupted and the
 * person chooses to continue), because resending would repeat or contradict what they already read.
 */

import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions } from "@myharness/ai";
import {
	getProviderFailure,
	isNetworkErrorCategory,
	isRetryableAssistantError,
	type ProviderErrorCategory,
	type ProviderFailureInfo,
} from "@myharness/ai/compat";
import type { SettingsManager } from "../../config/settings/index.ts";
import { sdkFirstByteTimeoutMs } from "../runtime/request-timeouts.ts";

/** Short pause before a network retry: long enough not to hammer a flapping gateway, short enough to feel immediate. */
export const NETWORK_RETRY_DELAY_MS = 1_500;

/**
 * Cap of the exponential backoff between automatic retries. With a large or unlimited attempt count the doubling
 * delay would otherwise grow past what any timer can wait (and past any useful recovery window).
 */
export const MAX_RETRY_BACKOFF_MS = 60_000;

/** The wait before retry `attempt` (1-based): `baseDelayMs` doubled per attempt, never longer than the cap. */
export function retryBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	return Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_RETRY_BACKOFF_MS);
}

/** Whether the failed message already carries output the person could see (text, reasoning or a tool call). */
export function hasVisibleOutput(message: AssistantMessage): boolean {
	return message.content.some((block) => {
		if (block.type === "text") return block.text.trim().length > 0;
		if (block.type === "thinking") return block.thinking.trim().length > 0;
		return block.type === "toolCall";
	});
}

export type RetryPlan =
	| { kind: "none" }
	/** HTTP-class failure, retried under the existing `retry.maxRetries` budget and backoff. */
	| { kind: "standard" }
	| { kind: "network"; category: ProviderErrorCategory; delayMs: number }
	/** A network failure after output started: no automatic resend. */
	| { kind: "interrupted"; category: ProviderErrorCategory };

export interface RetryPlanInput {
	message: AssistantMessage;
	retryEnabled: boolean;
	/** Context overflow is handled by compaction, never by a retry. */
	overflow: boolean;
	/** The message looks like a transient HTTP-class provider error (existing text-based check). */
	standardRetryable: boolean;
	/** Retries already made under the `maxRetries` budget, and that budget (Infinity for unlimited). */
	standardAttempts: number;
	standardMax: number;
	/** Network retries already made on the current model, and `retry.networkMaxAttempts`. */
	networkAttempts: number;
	networkMaxAttempts: number;
}

export function planRetry(input: RetryPlanInput): RetryPlan {
	const { message } = input;
	if (message.stopReason !== "error" || input.overflow) return { kind: "none" };
	const failure = getProviderFailure(message);
	if (failure && isNetworkErrorCategory(failure.category)) {
		if (hasVisibleOutput(message)) return { kind: "interrupted", category: failure.category };
		if (!input.retryEnabled) return { kind: "none" };
		// `networkAttempts` retries are done, so `networkAttempts + 1` attempts have failed (this one included).
		if (input.networkAttempts + 1 < input.networkMaxAttempts) {
			return { kind: "network", category: failure.category, delayMs: NETWORK_RETRY_DELAY_MS };
		}
		return { kind: "none" };
	}
	if (!input.retryEnabled || !input.standardRetryable) return { kind: "none" };
	if (input.standardAttempts >= input.standardMax) return { kind: "none" };
	return { kind: "standard" };
}

/** The classification recorded on a failed message, if any. */
export function failureOf(message: AssistantMessage): ProviderFailureInfo | undefined {
	return getProviderFailure(message);
}

/** What a one-shot completion needs from the model runtime. */
export interface NetworkPolicyRuntime {
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
	getModel(providerId: string, modelId: string): Model<Api> | undefined;
}

export interface CompleteWithNetworkPolicyInput {
	runtime: NetworkPolicyRuntime;
	settings: Pick<
		SettingsManager,
		| "getNetworkTimeouts"
		| "getNetworkMaxAttempts"
		| "getFallbackModelSettings"
		| "getRetrySettings"
		| "getProviderRetrySettings"
	>;
	model: Model<Api>;
	context: Context;
	options?: ModelsSimpleStreamOptions;
	/** Replaceable in tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * A one-shot completion (commit message, copy name) under the same retry settings as the main Agent run: the
 * first-byte limit, `retry.networkMaxAttempts` attempts on the same model for network failures, transient HTTP
 * failures retried on the `retry.maxRetries` budget with backoff, then the configured fallback model. `retry.enabled`
 * switches every automatic retry off, like the main Agent. Output is never resent after it started, and a cancelled
 * request (the caller's own signal) is returned as is - a stop the person chose is not a failure to retry.
 */
export async function completeWithNetworkPolicy(input: CompleteWithNetworkPolicyInput): Promise<AssistantMessage> {
	const { runtime, settings, context, options } = input;
	const sleep = input.sleep ?? abortableSleep;
	const maxAttempts = settings.getNetworkMaxAttempts();
	const retry = settings.getRetrySettings();
	const providerRetry = settings.getProviderRetrySettings();

	const run = async (model: Model<Api>): Promise<AssistantMessage> => {
		let message: AssistantMessage | undefined;
		// Retries already granted on this model, each under its own budget (like the session retry loop):
		// network failures count against `networkMaxAttempts` (the first attempt included), HTTP-class
		// failures against `retry.maxRetries` (which may be unlimited).
		let networkRetries = 0;
		let standardRetries = 0;
		for (;;) {
			message = await runtime.completeSimple(model, context, {
				...options,
				timeoutMs: options?.timeoutMs ?? sdkFirstByteTimeoutMs(model, settings),
				// The same provider-SDK budget the main Agent's stream function injects (sdk.ts).
				maxRetries: options?.maxRetries ?? providerRetry.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetry.maxRetryDelayMs,
			});
			if (options?.signal?.aborted) return message;
			const plan = planRetry({
				message,
				retryEnabled: retry.enabled,
				overflow: false,
				standardRetryable: isRetryableAssistantError(message),
				standardAttempts: standardRetries,
				standardMax: retry.maxRetries,
				networkAttempts: networkRetries,
				networkMaxAttempts: maxAttempts,
			});
			if (plan.kind === "network") networkRetries += 1;
			else if (plan.kind === "standard") standardRetries += 1;
			else return message;
			const delayMs =
				plan.kind === "network" ? plan.delayMs : retryBackoffDelayMs(retry.baseDelayMs, standardRetries);
			await sleep(delayMs, options?.signal);
			if (options?.signal?.aborted) return message;
		}
	};

	const first = await run(input.model);
	const failure = getProviderFailure(first);
	if (
		first.stopReason !== "error" ||
		!failure ||
		!isNetworkErrorCategory(failure.category) ||
		hasVisibleOutput(first)
	) {
		return first;
	}
	const fallback = settings.getFallbackModelSettings();
	if (!fallback.enabled || !fallback.provider || !fallback.model) return first;
	if (fallback.provider === input.model.provider && fallback.model === input.model.id) return first;
	const fallbackModel = runtime.getModel(fallback.provider, fallback.model);
	if (!fallbackModel) return first;
	return run(fallbackModel);
}
