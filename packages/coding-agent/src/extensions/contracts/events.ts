// biome-ignore-all lint/suspicious/noConfusingVoidType: Extension handlers allow bare returns for compatibility
/** Event names understood by the Extension API. Payloads are bound by the
 * compatibility layer; this module only owns the dependency-free event port. */
export type ExtensionEventName =
	| "project_trust"
	| "resources_discover"
	| "session_start"
	| "session_info_changed"
	| "session_before_switch"
	| "session_before_fork"
	| "session_before_compact"
	| "session_compact"
	| "session_shutdown"
	| "session_before_tree"
	| "session_tree"
	| "context"
	| "before_provider_request"
	| "before_provider_headers"
	| "after_provider_response"
	| "before_agent_start"
	| "agent_start"
	| "agent_end"
	| "agent_settled"
	| "agent_response_ready"
	| "turn_start"
	| "turn_end"
	| "message_start"
	| "message_update"
	| "message_end"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "model_select"
	| "thinking_level_select"
	| "user_bash"
	| "input"
	| "tool_call"
	| "tool_result";

/** Lightweight event envelope for code that only needs to route events. */
export interface ExtensionEventEnvelope<TType extends ExtensionEventName = ExtensionEventName> {
	type: TType;
}

/** Generic event handler port. The rich context is supplied by the compat layer. */
export type ExtensionEventHandler<TEvent = unknown, TResult = undefined, TContext = unknown> = (
	event: TEvent,
	ctx: TContext,
) => Promise<TResult | void> | TResult | void;

export interface ExtensionEventSubscription<TEvent = unknown, TResult = undefined, TContext = unknown> {
	event: ExtensionEventName;
	handler: ExtensionEventHandler<TEvent, TResult, TContext>;
}
