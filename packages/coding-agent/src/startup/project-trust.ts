import type { AppMode } from "../application/project-trust.ts";
import type { SettingsManager } from "../config/settings/index.ts";
import type { ProjectTrustContext } from "../extensions/compat/types.ts";

/** Startup trust decisions are exclusively answered through the browser. */
export function createProjectTrustContext(options: {
	cwd: string;
	mode: AppMode;
	settingsManager: SettingsManager;
	hasUI: boolean;
	webUi?: ProjectTrustContext["ui"];
}): ProjectTrustContext {
	return {
		cwd: options.cwd,
		mode: "web",
		hasUI: !!options.webUi,
		ui: options.webUi ?? {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: (message) => console.error(message),
		},
	};
}
