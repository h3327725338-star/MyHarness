import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshArtifactIndexesIfChanged } from "../src/session/artifacts/store.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

// The refresh still runs; the spy only records when the tool wrapper calls it.
vi.mock("../src/session/artifacts/store.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/session/artifacts/store.ts")>();
	return { ...actual, refreshArtifactIndexesIfChanged: vi.fn(actual.refreshArtifactIndexesIfChanged) };
});

describe("derived artifact indexes after apply_patch", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (directories.length > 0) {
			const directory = directories.pop();
			if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	});

	function tempDirectory(prefix: string): string {
		const directory = mkdtempSync(join(tmpdir(), prefix));
		directories.push(directory);
		return directory;
	}

	it("refreshes the derived indexes around an apply_patch call, as the wrapper does for edit and write", async () => {
		const project = tempDirectory("myharness-apply-patch-index-project-");
		const dataRoot = tempDirectory("myharness-apply-patch-index-data-");
		// A Session stored under the data root has the artifact scope that the refresh needs.
		const sessionManager = SessionManager.create(project, undefined, undefined, { dataRoot });
		const harness = await createHarness({ sessionManager, initialActiveToolNames: ["apply_patch"] });
		harnesses.push(harness);

		const refresh = vi.mocked(refreshArtifactIndexesIfChanged);
		refresh.mockClear();
		const refreshCountsAtToolStart: number[] = [];
		const refreshCountsAtToolEnd: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "apply_patch") {
				refreshCountsAtToolStart.push(refresh.mock.calls.length);
			}
			if (event.type === "tool_execution_end" && event.toolName === "apply_patch") {
				refreshCountsAtToolEnd.push(refresh.mock.calls.length);
			}
		});

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("apply_patch", {
					patch: ["*** Begin Patch", "*** Add File: made.txt", "+hello", "*** End Patch"].join("\n"),
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("add a note");

		expect(harness.eventsOfType("tool_execution_end")).toContainEqual(
			expect.objectContaining({ toolName: "apply_patch", isError: false }),
		);
		expect(refreshCountsAtToolStart).toEqual([0]);
		expect(refreshCountsAtToolEnd).toHaveLength(1);
		expect(refreshCountsAtToolEnd[0]).toBeGreaterThan(refreshCountsAtToolStart[0]!);
		expect(refresh.mock.calls[0]?.[0]).toMatchObject({
			workspaceId: expect.any(String),
			sessionId: expect.any(String),
		});
	});
});
