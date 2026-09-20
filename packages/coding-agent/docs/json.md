# JSON Event Stream Mode

```bash
myharness --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating MyHarness into other tools or custom UIs.

## Event Types

Events are defined in [`AgentSessionEvent`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/agent/runtime/agent-session.ts#L198):

```typescript
type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "agent_settled" }
  | { type: "auto_memory_error"; operation: "recall" | "extract" | "consolidate"; errorMessage: string }
  | { type: "vision_assistant_start"; progress: VisionAssistantProgress }
  | { type: "vision_assistant_end"; progress: VisionAssistantProgress; details: VisionAssistantMessageDetails }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "git_checkpoint_start" }
  | { type: "git_checkpoint_progress"; completedFiles: number; totalFiles: number; processedBytes: number; totalBytes: number }
  | { type: "git_checkpoint_end"; ok: boolean; checkpointId?: string; error?: string }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

`queue_update` emits the full pending steering and follow-up queues whenever they change. `compaction_start` and `compaction_end` cover both manual and automatic compaction.

Base events from [`AgentEvent`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/agent/src/types.ts#L422):

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## Message Types

Base messages from [`packages/ai/src/types.ts`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/ai/src/types.ts#L346):
- `UserMessage` (line 346)
- `AssistantMessage` (line 352)
- `ToolResultMessage` (line 367)

Extended messages from [`packages/coding-agent/src/agent/runtime/messages.ts`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/agent/runtime/messages.ts#L29):
- `BashExecutionMessage` (line 29)
- `CustomMessage` (line 46)
- `BranchSummaryMessage` (line 55)
- `CompactionSummaryMessage` (line 62)

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...],"willRetry":false}
```

## Example

```bash
myharness --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
