# Compaction & Branch Summarization

LLMs have limited context windows. When conversations grow too long, MyHarness uses compaction to summarize older content while preserving recent work. This page covers both auto-compaction and branch summarization.

**Source files** ([MyHarness](https://github.com/h3327725338-star/MyHarness)):
- [`packages/coding-agent/src/context/compact/compaction.ts`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/context/compact/compaction.ts) - Auto-compaction logic
- [`packages/coding-agent/src/context/compact/branch-summarization.ts`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/context/compact/branch-summarization.ts) - Branch summarization
- [`packages/coding-agent/src/context/compact/utils.ts`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/context/compact/utils.ts) - Shared utilities (file tracking, serialization)
- [`packages/coding-agent/src/session/types.ts`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/session/types.ts) - Entry types (`CompactionEntry`, `BranchSummaryEntry`)
- [`packages/coding-agent/src/extensions/contracts/events.ts`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/extensions/contracts/events.ts) - Extension event types

For TypeScript definitions in your project, inspect `node_modules/@myharness/coding-agent/dist/`.

## Overview

MyHarness has two summarization mechanisms:

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Compaction | Context exceeds threshold, or `/compact` | Summarize old messages to free up context |
| Branch summarization | Session tree navigation | Preserve context when switching branches |

Both use the same structured summary format and track file operations cumulatively.

## Compaction

### When It Triggers

Auto-compaction triggers when:

```
activeTokens >= floor(effectiveContextWindow * 0.85)
```

`effectiveContextWindow` is the minimum of the configured context window
(`contextWindow.main` / `contextWindow.subagent` in settings, or a CLI
`--context-window` override) and the model metadata `contextWindow`.

`reserveTokens` is runtime-adapted from the configured base (`compaction.reserveTokens`,
default 16384) and is never a fixed number: the effective reserve is
`max(baseReserve, 15% × effectiveContextWindow, model.maxTokens + 1024)`, capped just
below the window. The normal automatic trigger remains 85%; the provider budget guard
and provider overflow recovery are separate checks.

The same `activeTokens` measurement is the single runtime source of truth shared by the
UI footer, the provider budget guard and every agent lifecycle check. After a compaction
with no new provider usage anchor yet, `activeTokens` is a conservative estimate of the
everything-would-be-sent context (compaction summary + retained tail + new messages)
rather than an unknown value.

> **Budget Guard vs Auto Compact**
>
> Auto Compact only controls whether the runtime *may automatically compact*
> (`compaction.enabled`). The Context Budget Guard is independent: before every provider
> request the runtime checks whether the Active Context is within the safe budget. If
> `compaction.enabled` is `false` and the context is over budget, the runtime does **not**
> compact and also does **not** send the request — it reports a blocked state
> (`ContextBudgetBlockedError`) instead of relying on the provider to reject the request.

You can also trigger manually with `/compact [instructions]`, where optional instructions focus the summary.

### How It Works

1. **Find cut point**: Keep the last turn, or the latest valid assistant/tool boundary in a single long turn. The `keepRecentTokens` cut is a bounded fallback for summarization-request overflow.
2. **Extract messages**: Collect messages from the previous kept boundary (or session start) up to the cut point
3. **Generate summary**: Call LLM to summarize with structured format, passing the previous summary as iterative context when present
4. **Append entry**: Save `CompactionEntry` with summary and `firstKeptEntryId`
5. **Reload**: Session reloads, using summary + messages from `firstKeptEntryId` onwards
6. **Check the full next context**: The ideal target is 5% of the chat model's effective window, including system prompt, tools, retained messages and context transforms. A result up to 10% is accepted after one round. Above 10%, run one more round using the first checkpoint's actual rebuilt context, then keep the second result regardless of its size. There is no third round or target-miss error.

A flow emits one start/end pair and saves each completed round. Generation retries
consume the same two-round allowance. Cancellation or a failed second request leaves
the first checkpoint available. At the same context window, automatic compaction is
re-armed only after new messages since the checkpoint contribute at least 5% of the
window; restoring a checkpoint or a changed usage report cannot immediately restart it.
The independent provider hard limit still prevents sending an oversized request.

`/settings` provides **Compact Model**, with model and **Compact Thinking Effort**
controls inside. They use the existing provider catalog and supported thinking levels.
The effort is shared across Compact models and is preserved when switching models. If unset, the model and effort
follow the current chat settings (with effort clamped to the selected model's capabilities).
Explicit selections persist under `compaction.provider`, `compaction.model` and
`compaction.thinkingLevel`; they do not change the chat model.

```
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

On repeated compactions, the summarized span starts at the previous compaction's kept boundary (`firstKeptEntryId`), not at the compaction entry itself, falling back to the entry after the previous compaction if that kept entry cannot be found in the path. This preserves messages that survived the earlier compaction by including them in the next summarization pass as well. MyHarness also recalculates `tokensBefore` from the rebuilt session context before writing the new `CompactionEntry`, so the token count reflects the actual pre-compaction context being replaced.

### Split Turns

A "turn" starts with a user message and includes all assistant responses and tool calls until the next user message. Normally, compaction cuts at turn boundaries.

When a single turn exceeds `keepRecentTokens`, the cut point lands mid-turn at an assistant message. This is a "split turn":

```
Split turn (one huge turn exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (no complete turns before)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

For split turns, MyHarness generates two summaries and merges them:
1. **History summary**: Previous context (if any)
2. **Turn prefix summary**: The early part of the split turn

### Cut Point Rules

Valid cut points are:
- User messages
- Assistant messages
- BashExecution messages
- Custom messages (custom_message, branch_summary)

Never cut at tool results (they must stay with their tool call).

### CompactionEntry Structure

Defined in [`session/types.ts`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/session/types.ts):

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default compaction uses this for details (from compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extensions can store any JSON-serializable data in `details`. The default compaction tracks file operations, but custom extension implementations can use their own structure. Generated and extension-provided summaries store their LLM `usage` when available so session totals include summarization work.

See [`prepareCompaction()`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/context/compact/compaction.ts) and [`compact()`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/context/compact/compaction.ts) for the implementation. For direct programmatic summarization, `generateSummary()` returns the summary text and `generateSummaryWithUsage()` returns `{ text, usage }`.

## Branch Summarization

### When It Triggers

When navigating to a different branch in the session tree, MyHarness offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

### How It Works

1. **Find common ancestor**: Deepest node shared by old and new positions
2. **Collect entries**: Walk from old leaf back to common ancestor
3. **Prepare with budget**: Include messages up to token budget (newest first)
4. **Generate summary**: Call LLM with structured format
5. **Append entry**: Save `BranchSummaryEntry` at navigation point

```
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D ─ [summary of B,C,D]
    A ───┤
         └─ E ─ F (new leaf)
```

### Cumulative File Tracking

Both compaction and branch summarization track files cumulatively. When generating a summary, MyHarness extracts file operations from:
- Tool calls in the messages being summarized
- Previous compaction or branch summary `details` (if any)

This means file tracking accumulates across multiple compactions or nested branch summaries, preserving the full history of read and modified files.

### BranchSummaryEntry Structure

Defined in [`session/types.ts`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/session/types.ts):

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  fromId: string;      // Entry we navigated from
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Same as compaction, extensions can store custom data in `details`.

See [`collectEntriesForBranchSummary()`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/context/compact/branch-summarization.ts), [`prepareBranchEntries()`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/context/compact/branch-summarization.ts), and [`generateBranchSummary()`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/context/compact/branch-summarization.ts) for the implementation.

## Summary Format

Both compaction and branch summarization use the same structured format:

```markdown
## 目标
[用户想要完成什么？如果会话包含不同任务，可以列出多个目标。]

## 约束与偏好
- [用户提到的约束、偏好或要求]

## 进展
### 已完成
- [x] [已完成的任务或修改]

### 进行中
- [ ] [当前正在进行的工作]

### 受阻
- [阻碍进展的问题，如有]

## 关键决策
- **[决策]**：[简要理由]

## 后续步骤
1. [接下来应执行的事项，按顺序列出]

## 关键上下文
- [继续工作所需的数据、示例或参考资料]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### Message Serialization

Before summarization, messages are serialized to text via [`serializeConversation()`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/context/compact/utils.ts):

```
[User]: What they said
[Assistant thinking]: Internal reasoning
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

Tool results are truncated to 2000 characters during serialization. Content beyond that limit is replaced with a marker indicating how many characters were truncated. This keeps summarization requests within reasonable token budgets, since tool results (especially from `read` and `bash`) are typically the largest contributors to context size.

## Custom Summarization via Extensions

Extensions can intercept and customize both compaction and branch summarization. See [`extensions/contracts/events.ts`](https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/src/extensions/contracts/events.ts) for event type definitions.

### session_before_compact

Fired before auto-compaction or `/compact`. Can cancel or provide custom summary. See `SessionBeforeCompactEvent` and `CompactionPreparation` in the types file.

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  // preparation.messagesToSummarize - messages to summarize
  // preparation.turnPrefixMessages - split turn prefix (if isSplitTurn)
  // preparation.previousSummary - previous compaction summary
  // preparation.fileOps - extracted file operations
  // preparation.tokensBefore - context tokens before compaction
  // preparation.firstKeptEntryId - where kept messages start
  // preparation.settings - compaction settings

  // branchEntries - all entries on current branch (for custom state)
  // reason - "manual" (/compact), "threshold", or "overflow"
  // willRetry - whether the aborted turn is retried after compaction (overflow recovery)
  // signal - AbortSignal (pass to LLM calls)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // usage: summaryResponse.usage, // Optional; included in session totals
      details: { /* custom data */ },
    }
  };
});
```

#### Converting Messages to Text

To generate a summary with your own model, convert messages to text using `serializeConversation`:

```typescript
import { convertToLlm, serializeConversation } from "@myharness/coding-agent";

pi.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // Convert AgentMessage[] to Message[], then serialize to text
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // Returns:
  // [User]: message text
  // [Assistant thinking]: thinking content
  // [Assistant]: response text
  // [Assistant tool calls]: read(path="..."); bash(command="...")
  // [Tool result]: output text

  // Now send to your model for summarization
  const { summary, usage } = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage,
    }
  };
});
```

See [custom-compaction.ts](../examples/extensions/custom-compaction.ts) for a complete example using a different model.

### session_before_tree

Fired before session tree navigation. Always fires regardless of whether user chose to summarize. Can cancel navigation or provide custom summary.

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        // usage: summaryResponse.usage, // Optional; included in session totals
        details: { /* custom data */ },
      }
    };
  }
});
```

See `SessionBeforeTreeEvent` and `TreePreparation` in the types file.

## Settings

Configure compaction in `~/.myharness/agent/settings.json` or `<project-dir>/.myharness/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable auto-compaction |
| `reserveTokens` | `16384` | Tokens to reserve for LLM response |
| `keepRecentTokens` | `20000` | Recent tokens to keep (not summarized) |

Disable auto-compaction with `"enabled": false`. You can still compact manually with `/compact`.
