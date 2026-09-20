export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.MYHARNESS_EXPERIMENTAL === "1";
}
