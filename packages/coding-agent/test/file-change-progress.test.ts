import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createEditToolDefinition } from "../src/tools/files/edit.ts";
import { createWriteToolDefinition } from "../src/tools/files/write.ts";

it("reports the validated edit patch before the write settles", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const update = vi.fn();
	const tool = createEditToolDefinition(process.cwd(), {
		operations: {
			access: async () => {},
			readFile: async () => Buffer.from("before\n"),
			writeFile: async () => {
				expect(update).toHaveBeenCalledTimes(1);
				await gate;
			},
		},
	});
	const pending = tool.execute(
		"edit",
		{ path: "progress.txt", edits: [{ oldText: "before", newText: "after" }] },
		undefined,
		update,
		undefined,
	);
	await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
	expect(update.mock.calls[0][0].details.patch).toContain("+after");
	release();
	const result = await pending;
	expect(result.details?.patch).toBe(update.mock.calls[0][0].details.patch);
});

it("reports local write counts while the old contents are still on disk", async () => {
	const root = await mkdtemp(join(tmpdir(), "myharness-progress-"));
	try {
		const path = join(root, "progress.txt");
		await writeFile(path, "before\n");
		let oldContents: Promise<string> | undefined;
		const update = vi.fn(() => {
			oldContents = readFile(path, "utf8");
		});
		const result = await createWriteToolDefinition(root).execute(
			"write",
			{ path, content: "after\nextra\n" },
			undefined,
			update,
			undefined,
		);
		expect(update).toHaveBeenCalledExactlyOnceWith({ content: [], details: { additions: 2, deletions: 1 } });
		expect(await oldContents).toBe("before\n");
		expect(result.details).toMatchObject({ additions: 2, deletions: 1 });
		expect(await readFile(path, "utf8")).toBe("after\nextra\n");
	} finally {
		await rm(root, { recursive: true });
	}
});
