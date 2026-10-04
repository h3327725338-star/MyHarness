import type { DefaultProjectTrust } from "../config/settings/types.ts";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	type ProjectTrustStore,
} from "../config/trust/index.ts";
import { CONFIG_DIR_NAME } from "../config.ts";
import type { LoadExtensionsResult, ProjectTrustContext } from "../extensions/compat/types.ts";
import { emitProjectTrustEvent } from "../extensions/runtime/runner.ts";

export type AppMode = "web";

export interface ResolveProjectTrustedOptions {
	cwd: string;
	trustStore: ProjectTrustStore;
	trustOverride?: boolean;
	defaultProjectTrust?: DefaultProjectTrust;
	extensionsResult?: LoadExtensionsResult;
	projectTrustContext: ProjectTrustContext;
	onExtensionError?: (message: string) => void;
}

function formatProjectTrustPrompt(cwd: string): string {
	return `Trust project folder?\n${cwd}\n\nThis allows MyHarness to load ${CONFIG_DIR_NAME} settings and resources, install missing project packages, and execute project extensions.`;
}

async function selectProjectTrustOption(
	cwd: string,
	ctx: ProjectTrustContext,
): Promise<ProjectTrustOption | undefined> {
	const options = getProjectTrustOptions(cwd, { includeSessionOnly: true });
	const selected = await ctx.ui.select(
		formatProjectTrustPrompt(cwd),
		options.map((option) => option.label),
	);
	return options.find((option) => option.label === selected);
}

function saveProjectTrustPromptResult(trustStore: ProjectTrustStore, result: ProjectTrustOption): void {
	if (result.updates.length > 0) {
		trustStore.setMany(result.updates);
	}
}

export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	if (options.trustOverride !== undefined) {
		return options.trustOverride;
	}
	if (!hasTrustRequiringProjectResources(options.cwd)) {
		return true;
	}

	if (options.extensionsResult) {
		const { result, errors } = await emitProjectTrustEvent(
			options.extensionsResult,
			{ type: "project_trust", cwd: options.cwd },
			options.projectTrustContext,
		);
		for (const error of errors) {
			options.onExtensionError?.(`Extension "${error.extensionPath}" project_trust error: ${error.error}`);
		}
		if (result) {
			const trusted = result.trusted === "yes";
			if (result.remember === true) {
				options.trustStore.set(options.cwd, trusted);
			}
			return trusted;
		}
	}

	const decision = options.trustStore.get(options.cwd);
	if (decision !== null) {
		return decision;
	}

	switch (options.defaultProjectTrust ?? "ask") {
		case "always":
			return true;
		case "never":
			return false;
		case "ask":
			break;
	}

	if (!options.projectTrustContext.hasUI) {
		return false;
	}

	const selected = await selectProjectTrustOption(options.cwd, options.projectTrustContext);
	if (selected !== undefined) {
		saveProjectTrustPromptResult(options.trustStore, selected);
		return selected.trusted;
	}
	return false;
}
