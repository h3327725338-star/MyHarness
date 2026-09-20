# SDK Examples

Programmatic usage of myharness-coding-agent via `createAgentSession()` and `createAgentSessionRuntime()`. Every example that sends a prompt requires a configured Provider/model; this fork has no default Provider catalog.

The runtime example shows how to build a recreate function that closes over process-global fixed inputs and recreates cwd-bound services and sessions as the active session cwd changes.

## Examples

| File | Description |
|------|-------------|
| `01-minimal.ts` | Simplest usage with default resource discovery and a configured model |
| `02-custom-model.ts` | Select model and thinking level |
| `03-custom-prompt.ts` | Customize the system prompt |
| `04-skills.ts` | Discover, filter, or replace skills |
| `05-tools.ts` | Built-in tool allowlists |
| `06-extensions.ts` | Logging and blocking via hooks |
| `07-context-files.ts` | AGENTS.md context files |
| `08-prompt-templates.ts` | File-based prompt templates |
| `09-api-keys-and-oauth.ts` | API key resolution via custom auth paths |
| `10-settings.ts` | Override compaction and retry settings |
| `11-sessions.ts` | In-memory, persistent, continue, list sessions |
| `12-full-control.ts` | Replace everything, no discovery |
| `13-session-runtime.ts` | Manage runtime-backed session replacement |

## Running

```bash
cd packages/coding-agent
npx tsx examples/sdk/01-minimal.ts
```

## Quick Reference

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@myharness/coding-agent";

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("configured-provider", "configured-model");
if (!model) throw new Error("Configure a Provider and model first");

// Minimal
const { session } = await createAgentSession({ model, modelRuntime });

// Custom model
const customModel = modelRuntime.getModel("configured-provider", "another-model");
if (!customModel) throw new Error("Configure the selected model first");
const { session } = await createAgentSession({ model: customModel, thinkingLevel: "high", modelRuntime });

// Modify prompt
const loader = new DefaultResourceLoader({
  systemPromptOverride: (base) => `${base}\n\nBe concise.`,
});
await loader.reload();
const { session } = await createAgentSession({ resourceLoader: loader, modelRuntime });

// Read-only
const { session } = await createAgentSession({ tools: ["read", "grep", "find", "ls"], modelRuntime });

// In-memory
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

// Full control
const customRuntime = await ModelRuntime.create({
  authPath: "/my/app/auth.json",
  modelsPath: "/my/app/models.json",
});
customRuntime.setRuntimeApiKey("anthropic", process.env.MY_KEY!);
const customRuntimeModel = customRuntime.getModel("anthropic", "my-model");
if (!customRuntimeModel) throw new Error("Configure the model in /my/app/models.json first");

const resourceLoader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are helpful.",
  extensionFactories: [myExtension],
  skillsOverride: () => ({ skills: [], diagnostics: [] }),
  agentsFilesOverride: () => ({ agentsFiles: [] }),
  promptsOverride: () => ({ prompts: [], diagnostics: [] }),
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  model: customRuntimeModel,
  modelRuntime: customRuntime,
  resourceLoader,
  tools: ["read", "bash", "my_tool"],
  customTools: [myTool],
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory(),
});

// Run prompts
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await session.prompt("Hello");
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `modelRuntime` | Runtime using `agentDir/auth.json` and `models.json` | Canonical model and authentication runtime |
| `cwd` | `process.cwd()` | Working directory |
| `agentDir` | `~/.myharness/agent` | Config directory |
| `model` | From settings/first available | Model to use |
| `thinkingLevel` | From settings/`"medium"` | off, minimal, low, medium, high, xhigh, max |
| `tools` | `["read", "bash", "edit", "write", "symbols"]` built-ins | Allowlist tool names across built-in, extension, and custom tools |
| `customTools` | `[]` | Additional tool definitions |
| `resourceLoader` | DefaultResourceLoader | Resource loader for extensions, skills, prompts, themes, and context files |
| `sessionManager` | `SessionManager.create(cwd)` | Persistence |
| `settingsManager` | `SettingsManager.create(cwd, agentDir)` | Settings overrides |

## Events

```typescript
session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.result}`);
      break;
    case "agent_end":
      console.log("Done");
      break;
  }
});
```
