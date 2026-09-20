/**
 * Full Control
 *
 * Replace everything - no discovery, explicit configuration.
 */

import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@myharness/coding-agent";

const modelRuntime = await ModelRuntime.create({
	authPath: "/tmp/my-agent/auth.json",
	modelsPath: "/tmp/my-agent/models.json",
});
if (process.env.MY_ANTHROPIC_KEY) {
	modelRuntime.setRuntimeApiKey(process.env.MY_PROVIDER_ID ?? "my-provider", process.env.MY_ANTHROPIC_KEY);
}

const providerId = process.env.MY_PROVIDER_ID ?? "my-provider";
const modelId = process.env.MY_MODEL_ID ?? "my-model";
const model = modelRuntime.getModel(providerId, modelId);
if (!model) throw new Error(`Configure ${providerId}/${modelId} in /tmp/my-agent/models.json first`);

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 2 },
});

const cwd = process.cwd();

const resourceLoader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => `You are a minimal assistant.
Available: read, bash. Be concise.`,
	getAppendSystemPrompt: () => [],
	extendResources: () => {},
	reload: async () => {},
};

const { session } = await createAgentSession({
	cwd,
	agentDir: "/tmp/my-agent",
	model,
	thinkingLevel: "off",
	modelRuntime,
	resourceLoader,
	tools: ["read", "bash"],
	sessionManager: SessionManager.inMemory(cwd),
	settingsManager,
});

try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("List files in the current directory.");
	console.log();
} finally {
	session.dispose();
}
