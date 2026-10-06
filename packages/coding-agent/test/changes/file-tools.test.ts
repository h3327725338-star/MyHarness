import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChangeControl } from "../../src/changes/factory.ts";
import { createEditToolDefinition } from "../../src/tools/files/edit.ts";
import { createWriteToolDefinition } from "../../src/tools/files/write.ts";

function fixture(block = false) {
	const root = mkdtempSync(join(tmpdir(), "broker-files-"));
	const control = createChangeControl({
		workspaceRoot: root,
		agentDir: join(root, "state"),
		gates: block
			? [
					{
						name: "test-review",
						async check() {
							return { allow: false, code: "REUSE_REVIEW_REQUIRED", message: "review required" };
						},
					},
				]
			: [],
	});
	return { root, control };
}

describe("file tools use the injected broker", () => {
	it("checks the actual edit and refuses before writing", async () => {
		const { root, control } = fixture(true);
		writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
		const tool = createEditToolDefinition(root, { changeControl: control });
		await expect(
			tool.execute(
				"call",
				{ path: "a.ts", edits: [{ oldText: "1", newText: "2" }] },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toMatchObject({ code: "REUSE_REVIEW_REQUIRED" });
		expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
	});

	it("checks full writes, including copying into an existing file", async () => {
		const { root, control } = fixture(true);
		writeFileSync(join(root, "a.ts"), "old");
		const tool = createWriteToolDefinition(root, { changeControl: control });
		await expect(
			tool.execute(
				"call",
				{ path: "a.ts", content: "copied implementation" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toMatchObject({ code: "REUSE_REVIEW_REQUIRED" });
		expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("old");
	});

	it("commits through one owner and publishes real changes for both tools", async () => {
		const { root, control } = fixture();
		const origins: string[] = [];
		control.onCommitted((event) => {
			origins.push(event.origin.kind);
		});
		const write = createWriteToolDefinition(root, { changeControl: control });
		await write.execute(
			"create",
			{ path: "nested/a.ts", content: "export const a = 1;\r\n" },
			undefined,
			undefined,
			undefined as never,
		);
		const edit = createEditToolDefinition(root, { changeControl: control });
		await edit.execute(
			"edit",
			{ path: "nested/a.ts", edits: [{ oldText: "1", newText: "2" }] },
			undefined,
			undefined,
			undefined as never,
		);
		await write.execute(
			"overwrite",
			{ path: "nested/a.ts", content: "replacement\n" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(readFileSync(join(root, "nested/a.ts"), "utf8")).toBe("replacement\n");
		expect(origins).toEqual(["write", "edit", "write"]);
		expect(control.status().entries).toHaveLength(3);
	});

	it("does not delegate controlled writes to arbitrary remote operations", async () => {
		const { root, control } = fixture();
		let called = false;
		const tool = createWriteToolDefinition(root, {
			changeControl: control,
			operations: {
				async writeFile() {
					called = true;
				},
				async mkdir() {
					called = true;
				},
			},
		});
		await expect(
			tool.execute("remote", { path: "a.ts", content: "x" }, undefined, undefined, undefined as never),
		).rejects.toThrow("remote/custom");
		expect(called).toBe(false);
	});
});
