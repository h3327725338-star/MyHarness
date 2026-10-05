/** Internal NDJSON worker for isolated Explore tasks. Not a user-facing output mode. */

import { SettingsManager } from "../../config/settings/index.ts";
import { getAgentDir } from "../../config.ts";
import { flushRawStdout, restoreStdout, takeOverStdout, writeRawStdout } from "../../platform/process/output-guard.ts";
import { resolveCliModel } from "../../providers/runtime/model-resolver.ts";
import { SessionManager } from "../../session/manager/index.ts";
import { parseArgs } from "../../startup/args.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../runtime/services.ts";

export async function runDelegatedWorker(args: string[]): Promise<void> {
	takeOverStdout();
	try {
		const parsed = parseArgs(args);
		const cwd = process.cwd();
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				additionalExtensionPaths: parsed.extensions,
				noContextFiles: true,
				agentRole: "delegated",
				appendSystemPrompt: parsed.appendSystemPrompt,
			},
		});
		let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
		try {
			const resolved = resolveCliModel({
				cliProvider: parsed.provider,
				cliModel: parsed.model!,
				cliThinking: parsed.thinking,
				modelRuntime: services.modelRuntime,
			});
			if (!resolved.model) throw new Error(resolved.error ?? "Delegated model not available");
			const created = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(cwd, {
					mode: process.env.MYHARNESS_INTERNAL_CHAT_MODE === "general" ? "general" : "coding",
				}),
				model: resolved.model,
				thinkingLevel: parsed.thinking,
				tools: parsed.tools,
				contextWindowOverride: parsed.contextWindow,
			});
			session = created.session;
			await session.bindExtensions({ mode: "headless", onError: (error) => console.error(error.error) });
			session.subscribe((event) => writeRawStdout(`${JSON.stringify(event)}\n`));
			let prompt = "";
			process.stdin.setEncoding("utf8");
			for await (const chunk of process.stdin) prompt += chunk;
			await session.prompt(prompt);
		} finally {
			await session?.dispose();
			await services.dispose();
		}
	} finally {
		try {
			await flushRawStdout();
		} finally {
			restoreStdout();
		}
	}
}
