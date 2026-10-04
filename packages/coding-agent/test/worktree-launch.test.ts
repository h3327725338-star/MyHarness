import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { WorktreeLauncher } from "../src/modes/web/worktree-launch.ts";

it.skipIf(process.platform !== "win32")(
	"starts isolated copy service, reuses it and exposes its actual startup identity",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "copy-launch-"));
		const checkout = join(root, "checkout");
		mkdirSync(join(checkout, "packages/coding-agent/src/modes/web"), { recursive: true });
		writeFileSync(
			join(checkout, "packages/coding-agent/src/modes/web/web-mode.ts"),
			"// worktreeServiceIdentity fixture",
		);
		writeFileSync(join(checkout, "packages/coding-agent/src/web.ts"), "// Fixture entry marker");
		const loader = pathToFileURL(resolve("../../scripts/dev-fast-loader.mjs")).href;
		const entry = resolve("src/web.ts");
		writeFileSync(
			join(checkout, "web-runtime.ps1"),
			`& '${process.execPath}' --import '${loader}' '${entry}' --offline --no-extensions --no-context-files --approve @args\nexit $LASTEXITCODE\n`,
		);
		const launcher = new WorktreeLauncher(join(root, "agent"));
		const copy = { path: checkout, isMain: false, locked: false, branch: "test-copy" };
		let url: string | undefined;
		try {
			const started = await launcher.start(copy, 20);
			url = started.url;
			expect(await launcher.start(copy, 20)).toEqual(started);
			await expect
				.poll(async () => ((await fetch(`${url}api/boot`).then((r) => r.json())) as { phase: string }).phase, {
					timeout: 45000,
				})
				.toBe("ready");
			const boot = (await fetch(`${url}api/boot`).then((r) => r.json())) as { worktreeService: { path: string } };
			expect(boot.worktreeService.path).toBe(checkout);
			const originalState = (await fetch(`${url}api/state`).then((r) => r.json())) as { session: { id: string } };
			const before = (await fetch(`${url}api/boot`).then((r) => r.json())) as { instanceId: string };
			const restarted = await fetch(`${url}api/restart`, {
				method: "POST",
				headers: { "x-myharness-web": "1", "content-type": "application/json" },
				body: "{}",
			});
			expect(restarted.ok).toBe(true);
			await expect
				.poll(
					async () => {
						try {
							const next = (await fetch(`${url}api/boot`).then((r) => r.json())) as {
								instanceId: string;
								phase: string;
							};
							return next.instanceId !== before.instanceId && next.phase === "ready";
						} catch {
							return false;
						}
					},
					{ timeout: 45000 },
				)
				.toBe(true);
			const restoredState = (await fetch(`${url}api/state`).then((r) => r.json())) as { session: { id: string } };
			expect(restoredState.session.id).toBe(originalState.session.id);
			const settings = (await fetch(`${url}api/settings`).then((r) => r.json())) as {
				items: { id: string; value: number }[];
			};
			expect(settings.items.find((item: { id: string }) => item.id === "worktreeShutdownGraceSeconds")?.value).toBe(
				20,
			);
		} finally {
			if (url)
				await fetch(`${url}api/shutdown`, {
					method: "POST",
					headers: { "x-myharness-web": "1", "content-type": "application/json" },
					body: "{}",
				}).catch(() => {});
		}
	},
	90000,
);
