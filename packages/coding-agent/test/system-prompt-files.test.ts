import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A fresh process proves that module-level policies use editable files, with no hardcoded fallback.
// This private fixture creates only ordinary files/directories, never junctions or symlinks.
describe("system prompt file integration", () => {
	it("starts and builds from a partial custom directory, warning and skipping invalid files", () => {
		const directory = mkdtempSync(join(tmpdir(), "myharness-prompt-integration-"));
		try {
			for (const scope of ["global", "roles", "session"]) mkdirSync(join(directory, scope));
			writeFileSync(join(directory, "global/core.md"), "EDITED_CORE\n");
			writeFileSync(join(directory, "global/output-language.md"), " \n");
			writeFileSync(join(directory, "roles/main.md"), Buffer.from([0xff]));
			writeFileSync(join(directory, "session/working-directory.md"), "DIRECTORY={{cwd}}\n");
			const source = new URL("../src/system-prompts/composer/index.ts", import.meta.url).href;
			const child = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--input-type=module",
					"-e",
					`import {buildSystemPrompt} from ${JSON.stringify(source)}; console.log(buildSystemPrompt({cwd:'/task',selectedTools:[]}));`,
				],
				{
					cwd: fileURLToPath(new URL("../../..", import.meta.url)),
					env: { ...process.env, MYHARNESS_SYSTEM_PROMPT_DIR: directory },
					encoding: "utf8",
					timeout: 30000,
				},
			);
			expect(child.error).toBeUndefined();
			expect(child.status).toBe(0);
			expect(child.stdout).toContain("EDITED_CORE");
			expect(child.stdout).toContain("DIRECTORY=/task");
			expect(child.stdout).not.toContain("You are a helpful software engineering assistant");
			expect(child.stdout).not.toContain("<agent_role_policy>");
			expect(child.stdout).not.toContain("<output_language_policy>");
			expect(child.stderr).toContain("warning: skipping");
			expect(child.stderr).toContain("empty prompt");
			expect(child.stderr).toContain("ENOENT");
		} finally {
			rmSync(directory, { recursive: true });
		}
	});
});
