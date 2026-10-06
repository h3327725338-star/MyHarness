// Child process of the cross-process lock tests: applies one stored changeset and prints the outcome as JSON.
// argv: workspaceRoot storeRoot changesetId permitId holdMs lockTimeoutMs
import { ChangeStore } from "../../../src/changes/change-store.ts";
import { ChangeControlError } from "../../../src/changes/errors.ts";
import { ChangeExecutor, defaultChangeFs } from "../../../src/changes/executor.ts";

const [workspaceRoot, storeRoot, changesetId, permitId, holdMs, lockTimeoutMs] = process.argv.slice(2) as [
	string,
	string,
	string,
	string,
	string,
	string,
];

const executor = new ChangeExecutor({
	store: new ChangeStore(storeRoot),
	workspaceRoot,
	lock: { timeoutMs: Number(lockTimeoutMs) },
	fs: {
		read: defaultChangeFs.read,
		remove: defaultChangeFs.remove,
		async write(path, bytes) {
			// Hold the files for a while so the other process really contends for them.
			await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
			return defaultChangeFs.write(path, bytes);
		},
	},
});

try {
	const result = await executor.apply(changesetId, { permitId });
	process.stdout.write(`${JSON.stringify({ ok: true, files: result.files.map((file) => file.path) })}\n`);
} catch (error) {
	const code = error instanceof ChangeControlError ? error.code : "other";
	process.stdout.write(`${JSON.stringify({ ok: false, code, message: (error as Error).message })}\n`);
}
