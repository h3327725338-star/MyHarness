import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getMyHarnessInvocation } from "../src/utils/myharness-invocation.ts";

const snapshot = {
	execArgv: process.execArgv,
	argv1: process.argv[1],
	entry: process.env.MYHARNESS_PROCESS_ENTRY,
	legacy: process.env.MYHARNESS_CLI_ENTRY,
};

afterEach(() => {
	process.execArgv = snapshot.execArgv;
	process.argv[1] = snapshot.argv1;
	if (snapshot.entry === undefined) delete process.env.MYHARNESS_PROCESS_ENTRY;
	else process.env.MYHARNESS_PROCESS_ENTRY = snapshot.entry;
	if (snapshot.legacy === undefined) delete process.env.MYHARNESS_CLI_ENTRY;
	else process.env.MYHARNESS_CLI_ENTRY = snapshot.legacy;
});

describe("getMyHarnessInvocation", () => {
	// Any file that really exists: the function only checks existence before choosing this branch.
	const script = path.join(process.cwd(), "package.json");

	it("forwards the parent runtime flags so the child loads the same sources the parent runs", () => {
		delete process.env.MYHARNESS_PROCESS_ENTRY;
		delete process.env.MYHARNESS_CLI_ENTRY;
		process.execArgv = ["--import", "file:///dev-fast-loader.mjs"];
		process.argv[1] = script;
		const invocation = getMyHarnessInvocation(["--internal-delegated-worker"]);
		// The dev launcher starts the app as `node --import scripts/dev-fast-loader.mjs src/web.ts`; losing the
		// flags made spawned sub-agents resolve @myharness/* to the compiled dist and crash at module load.
		expect(invocation.command).toBe(process.execPath);
		expect(invocation.args.slice(0, 3)).toEqual(["--import", "file:///dev-fast-loader.mjs", script]);
		expect(invocation.args.at(-1)).toBe("--internal-delegated-worker");
	});

	it("forwards the flags for an explicit process entry too", () => {
		process.env.MYHARNESS_PROCESS_ENTRY = script;
		process.execArgv = ["--conditions", "source"];
		const invocation = getMyHarnessInvocation(["--x"]);
		expect(invocation.args).toEqual(["--conditions", "source", script, "--x"]);
	});

	it("adds nothing when the parent has no flags (production dist and packaged runs stay unchanged)", () => {
		delete process.env.MYHARNESS_PROCESS_ENTRY;
		delete process.env.MYHARNESS_CLI_ENTRY;
		process.execArgv = [];
		process.argv[1] = script;
		const invocation = getMyHarnessInvocation(["--task"]);
		expect(invocation.args).toEqual([script, "--task"]);
	});

	it("makes cwd-relative loader specifiers absolute for children spawned in another workspace", () => {
		delete process.env.MYHARNESS_PROCESS_ENTRY;
		delete process.env.MYHARNESS_CLI_ENTRY;
		process.argv[1] = script;
		// The real dev launcher line: `node --import scripts/dev-fast-loader.mjs packages/coding-agent/src/web.ts`.
		// The sub-agent child starts in the task's folder, so a relative specifier must be pinned to this cwd.
		let root = process.cwd();
		while (!fs.existsSync(path.join(root, "scripts", "dev-fast-loader.mjs")) && path.dirname(root) !== root) {
			root = path.dirname(root);
		}
		const loader = path.relative(process.cwd(), path.join(root, "scripts", "dev-fast-loader.mjs"));
		process.execArgv = ["--import", loader, "--conditions", "source"];
		let invocation = getMyHarnessInvocation(["--task"]);
		expect(invocation.args.slice(0, 4)).toEqual([
			"--import",
			pathToFileURL(path.join(root, "scripts", "dev-fast-loader.mjs")).href,
			"--conditions",
			"source",
		]);
		// The --flag=value form behaves the same; a bare package specifier and non-existing paths stay untouched.
		process.execArgv = ["--import=tsx", "--import", "scripts/does-not-exist.mjs"];
		invocation = getMyHarnessInvocation(["--task"]);
		expect(invocation.args.slice(0, 4)).toEqual(["--import=tsx", "--import", "scripts/does-not-exist.mjs", script]);
		// A relative entry script is absolutized as well: it resolves against the child's cwd otherwise.
		process.execArgv = [];
		process.argv[1] = path.join("package.json");
		invocation = getMyHarnessInvocation(["--task"]);
		expect(invocation.args).toEqual([path.join(process.cwd(), "package.json"), "--task"]);
	});
});
