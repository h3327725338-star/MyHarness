/** Internal NDJSON worker for isolated Explore tasks. Not a user-facing output mode. */

import { SettingsManager } from "../../config/settings/index.ts";
import { getAgentDir } from "../../config.ts";
import { flushRawStdout, restoreStdout, takeOverStdout, writeRawStdout } from "../../platform/process/output-guard.ts";
import { resolveCliModel } from "../../providers/runtime/model-resolver.ts";
import { SessionManager } from "../../session/manager/index.ts";
import { parseArgs } from "../../startup/args.ts";
import { setDelegatedCapabilities } from "../runtime/role.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../runtime/services.ts";

/**
 * One stdin line of the delegated worker protocol. The parent writes the
 * initial `prompt` line right after spawn and may keep writing `steer` lines
 * while the session runs; those become real steering messages in the child.
 *
 * A parent from before this protocol writes the plain task text and closes
 * stdin. `runDelegatedWorker` keeps that as a fallback prompt: a version
 * mismatch between a long-running parent and a freshly started worker must not
 * silently drop the task.
 */
export function parseDelegatedWorkerLine(line: string): { type: "prompt" | "steer"; text: string } | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	let value: { type?: unknown; text?: unknown };
	try {
		value = JSON.parse(trimmed) as { type?: unknown; text?: unknown };
	} catch {
		return undefined;
	}
	const text = typeof value.text === "string" ? value.text : "";
	if (text.trim() === "") return undefined;
	if (value.type === "prompt") return { type: "prompt", text };
	if (value.type === "steer") return { type: "steer", text };
	return undefined;
}

export async function runDelegatedWorker(args: string[]): Promise<void> {
	takeOverStdout();
	try {
		// The parent process declares this worker's capability through the
		// environment. Anything but the explicit "read-write" value stays on the
		// historical read-only tool boundary.
		setDelegatedCapabilities(
			process.env.MYHARNESS_INTERNAL_DELEGATED_MODE === "read-write" ? "read-write" : "read-only",
		);
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
		const pendingSteers: string[] = [];
		let promptSeen = false;
		let resolveInitialPrompt!: (text: string | null) => void;
		const initialPrompt = new Promise<string | null>((resolve) => {
			resolveInitialPrompt = resolve;
		});
		const deliverSteer = (text: string) => {
			const target = session;
			if (!target) {
				pendingSteers.push(text);
				return;
			}
			void Promise.resolve(target.steer(text)).catch(() => {
				// A steering reminder must never crash the worker.
			});
		};
		// Plain (pre-protocol) task text, kept only until a real prompt line wins.
		const legacyPromptLines: string[] = [];
		const handleWorkerLine = (line: string) => {
			const input = parseDelegatedWorkerLine(line);
			if (input) {
				if (input.type === "prompt") {
					if (!promptSeen) {
						promptSeen = true;
						resolveInitialPrompt(input.text);
					}
					return;
				}
				deliverSteer(input.text);
				return;
			}
			const trimmed = line.trim();
			if (!promptSeen && trimmed !== "" && !trimmed.startsWith("{")) legacyPromptLines.push(line);
		};
		const readLoop = (async () => {
			process.stdin.setEncoding("utf8");
			let buffer = "";
			for await (const chunk of process.stdin) {
				buffer += String(chunk);
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) handleWorkerLine(line);
			}
			if (buffer !== "") handleWorkerLine(buffer);
			if (!promptSeen && legacyPromptLines.length > 0) {
				promptSeen = true;
				resolveInitialPrompt(legacyPromptLines.join("\n"));
			}
			if (!promptSeen) resolveInitialPrompt(null);
		})().catch(() => {
			// Stdin errors are surfaced through the parent watchdog, not here.
			resolveInitialPrompt(null);
		});
		void readLoop;
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
			const promptText = await initialPrompt;
			if (promptText !== null) {
				// Steers that arrived before the session existed are queued and
				// delivered right after the initial prompt turn begins.
				const queued = pendingSteers.splice(0, pendingSteers.length);
				for (const text of queued) {
					try {
						await session.steer(text);
					} catch {
						// Ignore malformed or rejected reminders.
					}
				}
				await session.prompt(promptText);
			}
		} finally {
			// The parent keeps stdin open for steering reminders, so release the
			// stdin handle to let the worker exit as soon as its task finishes.
			const stdinStream = process.stdin as NodeJS.ReadStream & { unref?: () => void };
			try {
				stdinStream.unref?.();
			} catch {
				// Exit path is still covered by the parent process kill.
			}
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
