import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSymbolsToolRuntime } from "../../src/tools/symbols-runtime.ts";

describe("createSymbolsToolRuntime assembly", () => {
	let testWorkspace: string;

	beforeEach(async () => {
		testWorkspace = await mkdtemp(path.join(tmpdir(), "symbols-assembly-test-"));
	});

	afterEach(async () => {
		await rm(testWorkspace, { recursive: true, force: true });
	});

	it("default path creates no index object and defers runtime instantiation", () => {
		const runtime = createSymbolsToolRuntime(testWorkspace);

		// 1. index is completely omitted in default path (no CodeSymbolIndex created)
		expect("index" in runtime).toBe(false);

		// 2. getStatus prior to any router activity does not eagerly instantiate heavy runtime
		const initialStatus = runtime.getStatus();
		expect(initialStatus.semanticConfigured).toBe(false);
		expect(initialStatus.symbolStoreEntryCount).toBe(0);

		// 3. supportsSymbolIds flag is enabled
		expect(runtime.supportsSymbolIds).toBe(true);
	});
});
