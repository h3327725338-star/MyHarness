import { describe, expect, it, vi } from "vitest";

// The queue resolves each path with realpath before it takes its turn. Make the very first lookup slow, the way a busy
// disk does, so the second call's keys are ready before the first call's.
let lookups = 0;
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		realpath: async () => {
			lookups++;
			if (lookups === 1) await new Promise((resolve) => setTimeout(resolve, 50));
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		},
	};
});

const { withFileMutationQueue } = await import("../src/tools/files/file-mutation-queue.ts");

describe("withFileMutationQueue order", () => {
	it("runs operations on one file in the order they were issued, even when a later one resolves first", async () => {
		lookups = 0;
		const order: string[] = [];
		const first = withFileMutationQueue("C:/tmp/queue/file.txt", async () => {
			order.push("write");
		});
		const second = withFileMutationQueue("C:/tmp/queue/file.txt", async () => {
			order.push("edit");
		});
		await Promise.all([first, second]);
		expect(order).toEqual(["write", "edit"]);
	});
});
