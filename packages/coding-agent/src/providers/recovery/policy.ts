/**
 * Provider-level recovery for the local Task lifecycle.
 *
 * The local Task (AgentSession transcript, executed tool results, agent state)
 * is the highest lifecycle in myHarness. A provider conversation
 * is a disposable reasoning channel: a provider conversation can fail, be
 * dropped and be rebuilt — none of that may end the Task.
 *
 * This module owns the pure pieces: error classification, the per-conversation
 * recovery budget, and the internal recovery messages. `AgentSession` owns the
 * state machine and wires it into the agent loop.
 *
 * Design notes:
 * - Recoverable errors are protocol/stream-structure failures (tool-call markup
 *   that will not parse, dropped or INCOMPLETE responses, provider protocol
 *   mismatches). They are NOT reported as a failed Task; the runtime keeps the
 *   Task alive and tries to make progress.
 * - Transient transport/limit errors (429, 5xx, network, overloaded) are left to
 *   the existing Auto-Retry policy, which already covers them and honors the
 *   user's configured attempt budget. See `isRecoverableProviderFailure`.
 * - Cross-conversation continuation is bounded while the cascade produces no
 *   new local progress (no executed tool result and no successful assistant
 *   turn). The failure wording is not part of that decision, so alternating
 *   error messages cannot keep opening fresh conversations.
 */

import type { AssistantMessage } from "@myharness/ai/compat";

/** Lower bound of the per-conversation recovery budget. */
export const PROVIDER_RECOVERY_MIN_BUDGET = 3;
/** Upper bound of the per-conversation recovery budget. */
export const PROVIDER_RECOVERY_MAX_BUDGET = 5;

/**
 * Random recovery budget for one conversation: 3, 4 or 5 attempts. The budget
 * is intentionally not fixed so a server-side failure mode that correlates with
 * one specific pattern does not always exhaust at the same point.
 */
export function rollProviderRecoveryBudget(random: () => number = Math.random): number {
	const span = PROVIDER_RECOVERY_MAX_BUDGET - PROVIDER_RECOVERY_MIN_BUDGET + 1;
	const raw = random();
	const bucket = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw * span), 0), span - 1) : 0;
	return PROVIDER_RECOVERY_MIN_BUDGET + bucket;
}

/**
 * Failures that re-prompting or rebuilding a conversation cannot fix. Quota and
 * billing exhaustion are account/plan level, not transient, so they must not be
 * treated as recoverable provider hiccups.
 */
const PERMANENT_FAILURE_PATTERNS: readonly RegExp[] = [
	/insufficient_quota/i,
	/out of budget/i,
	/quota exceeded/i,
	/usage limit reached/i,
	/available balance/i,
	/\bbilling\b/i,
];

/**
 * Protocol, stream and model-output failures that are worth continuing from.
 * These cover the tool-call markup classes plus dropped/incomplete responses.
 */
const RECOVERABLE_FAILURE_PATTERNS: readonly RegExp[] = [
	// Tool-call / markup parsing.
	/could not be parsed/i,
	/could not parse/i,
	/unparseable/i,
	/unable to parse/i,
	/failed to parse/i,
	/parse (?:error|failure)/i,
	/tool[-_ ]?call markup/i,
	/tool[-_ ]?calls? .*(?:parse|malformed|invalid)/i,
	/markup .*(?:parse|malformed|invalid|unclosed)/i,
	/invalid tool call/i,
	/unknown tool call/i,
	/unclosed (?:tool|invoke|call|markup|wrapper)/i,
	/unterminated (?:tool|invoke|call|markup|block)/i,
	/tool call .*truncated/i,
	// Stream termination / transport drops.
	/stream ended/i,
	/(?:response|stream|turn|reply|message) ended before/i,
	/ended without/i,
	/premature (?:end|close|eof)/i,
	/completion .*incomplete/i,
	/\bINCOMPLETE\b/,
	/\bEOF\b/,
	// NOTE: request/connection *timeouts*, connection resets and fetch
	// failures are intentionally NOT listed here. They are transient
	// transport failures owned by Auto-Retry (which applies backoff and the
	// user's configured budget); with retry disabled the run must still
	// terminate (e.g. as `timed_out`) instead of spinning without backoff.
	// Model produced a response the runtime could not use.
	/malformed (?:tool|response|output|markup)/i,
	/invalid (?:tool|response) (?:call|output|format)/i,
	// Zero-output turn: the stream finished cleanly but contained no answer text
	// and no tool call (a provider may do this under transient server-side
	// pressure). Reporting it as a normal completion would fake task success.
	/(?:EMPTY_RESPONSE|EMPTY_REPLY|EMPTY_OUTPUT)\b/i,
	/empty (?:response|reply|answer|output)/i,
	/stream finished without any text or tool call/i,
	// Provider-layer protocol mismatches (unexpected body/content type, missing
	// ids): transient server behavior, not a permanent task error.
	/unexpected (?:json|content type|response)/i,
	/non-json/i,
	/returned no (?:session|file|message) id/i,
	// Transient provider busy/wait wording.
	/server (?:is )?busy/i,
	/please try again later/i,
	/稍后重试/,
	/服务繁忙/,
	/系统繁忙/,
	// Localized (system prompt / provider text uses Chinese in this repo).
	/无法解析/,
	/解析失败/,
	/断流/,
	/未正常完成/,
	/工具调用.*(?:失败|无法|异常|解析)/,
];

/** Whether a completed provider turn contained no usable answer or tool call. */
export function isProviderEmptyResponseFailure(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return /(?:EMPTY_RESPONSE|EMPTY_REPLY|EMPTY_OUTPUT)\b|empty (?:response|reply|answer|output)|stream finished without any text or tool call|无有效输出/i.test(
		errorMessage,
	);
}

/** Whether the failure is permanent (quota/billing) and must not be retried. */
export function isPermanentProviderFailure(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return PERMANENT_FAILURE_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Whether the raw error text looks like a recoverable protocol/stream failure.
 * String-only variant, used where only the message is available.
 */
export function isRecoverableProtocolFailure(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	if (isPermanentProviderFailure(errorMessage)) return false;
	return RECOVERABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Whether a failed assistant turn should be recovered instead of ending the
 * Task.
 *
 * Deliberate boundary:
 * - Transient transport/limit errors (429, 5xx, network, overloaded) return
 *   false here even though `isRetryableAssistantError` recognizes them: those
 *   are already owned by the existing Auto-Retry policy, including its
 *   user-configured attempt budget. Claiming them here would create a second,
 *   unbounded retry system and silently defeat `maxRetries`. Provider recovery
 *   therefore covers exactly the protocol/stream-structure class that Auto-Retry
 *   does not recognize and that used to kill the Task outright.
 */
export function isRecoverableProviderFailure(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const errorMessage = message.errorMessage;
	if (!errorMessage) return false;
	if (isPermanentProviderFailure(errorMessage)) return false;
	return RECOVERABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Internal recovery instruction for a same-conversation recovery.
 *
 * The un-parsed turn produced no usable tool calls, so nothing from it was
 * executed. The message states that explicitly and tells the model to re-issue
 * only the pending call instead of restarting the task or repeating work that
 * already succeeded.
 */
export function buildProviderRecoveryMessage(args: { failure: string; attempt: number; budget: number }): string {
	// The cause sentence must match what actually happened: markup failures and
	// empty/ dropped turns are different anomalies, and telling the model its
	// "markup failed to parse" when the reply was simply empty would confuse the
	// retry. Both variants keep the load-bearing guarantee: nothing from that
	// turn was executed.
	const markupFailure = /markup|parse|DSML/i.test(args.failure);
	const cause = markupFailure
		? "its tool-call markup failed to parse, so that turn produced no usable tool call"
		: "the provider returned no usable output for that turn";
	return `<harness_recovery>
Your previous turn could not be executed: ${cause} and NOTHING from it was executed.

Failure: ${args.failure}

Continue the current task from the failed position:
- Re-issue ONLY the tool call(s) that were not executed, using the tool-calling protocol exactly as specified in the system instructions, with complete arguments.
- Do NOT restart the task. Do NOT repeat tool calls that already completed successfully — their results are already in the transcript above, and re-running them may duplicate side effects.
- If no further tool call is needed, continue with the next concrete step or give the final answer.

Recovery attempt ${args.attempt}/${args.budget} in the current conversation.
</harness_recovery>`;
}

/**
 * Internal recovery instruction after the previous conversation was discarded.
 *
 * The local transcript is unchanged and remains the authoritative progress
 * record; only the reasoning channel is new. This message re-anchors the model
 * on the same task so a conversation rebuild cannot silently change or restart
 * the objective.
 */
export function buildConversationRebuildMessage(args: {
	failure: string;
	conversation: number;
	budget: number;
}): string {
	return `<harness_recovery mode="recovery">
The previous reasoning conversation was discarded after repeated provider/tool-protocol failures. A fresh conversation has been opened for the SAME local task: the transcript above is unchanged and is the authoritative progress record.

Failure that ended the previous conversation: ${args.failure}
Resume rules:
- Resume from exactly where the task stopped. Do not restart it and do not repeat tool actions that already completed successfully (their results are above).
- The last failed turn's tool calls were NOT executed.
- Re-issue the pending tool call(s) with complete arguments, or continue with the next concrete step.

New conversation #${args.conversation}, recovery budget ${args.budget}.
</harness_recovery>`;
}
