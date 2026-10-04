#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli.ts [args...]
 */
import { APP_NAME } from "./config.ts";
import { main } from "./main.ts";
import { configureHttpDispatcher } from "./platform/process/http-dispatcher.ts";

process.title = APP_NAME;
process.env.MYHARNESS_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

const args = process.argv.slice(2);
const run =
	args[0] === "--internal-delegated-worker"
		? import("./agent/delegation/worker.ts").then(({ runDelegatedWorker }) => runDelegatedWorker(args.slice(1)))
		: main(args);
void run.catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
