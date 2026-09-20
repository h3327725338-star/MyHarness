export function getMyHarnessUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `myharness/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
