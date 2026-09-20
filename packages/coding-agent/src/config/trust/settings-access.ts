/** Whether project-local settings may participate in the current runtime view. */
export function canReadProjectSettings(projectTrusted: boolean): boolean {
	return projectTrusted;
}

/** Enforce the existing trust boundary before writing project-local settings. */
export function assertProjectSettingsWritable(projectTrusted: boolean): void {
	if (!projectTrusted) {
		throw new Error("Project is not trusted; refusing to write project settings");
	}
}
