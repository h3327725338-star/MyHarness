import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

function fixture(confirmed = true, failure = false) {
	const source = readFileSync(new URL("../web/js/service-restart.js", import.meta.url), "utf8");
	const state: any = { snap: { session: { id: "chat" } }, view: { panelOpen: true } };
	const updates: any[] = [];
	let boots = 0;
	const post = vi.fn(async () => {
		if (failure) throw new Error("Restart refused");
	});
	const toast = vi.fn();
	const save = vi.fn();
	const reload = vi.fn();
	const context = vm.createContext({
		state,
		set: (update: any) => {
			updates.push(update);
			Object.assign(state, update);
		},
		api: async (path: string) =>
			path === "/api/state"
				? state.snap
				: ++boots === 1
					? { instanceId: "old" }
					: { instanceId: "new", phase: "ready" },
		post,
		toast,
		saveRestartState: save,
		location: { reload },
		t: (text: string) => text,
		confirmDialog: async () => confirmed,
		setTimeout: (callback: () => void) => callback(),
	});
	vm.runInContext(
		source.replace(/^import .*;\r?\n/gm, "").replace("export async function", "async function"),
		context,
	);
	return { state, updates, post, toast, save, reload, restart: () => context.restartService() };
}

it("confirms once, waits for the new service, saves tab state and reloads the page", async () => {
	const fx = fixture();
	await Promise.all([fx.restart(), fx.restart()]);
	expect(fx.post).toHaveBeenCalledTimes(1);
	expect(fx.save).toHaveBeenCalledWith("chat", { panelOpen: true, selectedTerminal: null });
	expect(fx.reload).toHaveBeenCalledTimes(1);
	expect(fx.updates.map((update) => update.restartPhase).filter(Boolean)).toEqual([
		"requesting",
		"waiting",
		"restoring",
	]);
	expect(fx.state.restarting).toBe(false);
	expect(fx.state.restartError).toBeNull();
	expect(fx.toast).not.toHaveBeenCalled();
});

it("cancels without restarting and keeps failures inline for retry", async () => {
	const cancelled = fixture(false);
	await cancelled.restart();
	expect(cancelled.post).not.toHaveBeenCalled();
	const failed = fixture(true, true);
	await failed.restart();
	expect(failed.state.restartError).toBe("Restart refused");
	expect(failed.state.restarting).toBe(false);
	expect(failed.toast).not.toHaveBeenCalled();
	expect(failed.reload).not.toHaveBeenCalled();
});

it("keeps the page and draft when the reload handoff cannot be saved", async () => {
	const fx = fixture();
	fx.save.mockImplementation(() => {
		throw new Error("Storage full");
	});
	await fx.restart();
	expect(fx.state.restartError).toBe("Storage full");
	expect(fx.reload).not.toHaveBeenCalled();
});

it("does not overlay the header and guards both click and keyboard sending during restart", () => {
	const app = readFileSync(new URL("../web/js/app.js", import.meta.url), "utf8");
	const panel = readFileSync(new URL("../web/js/panel-context.js", import.meta.url), "utf8");
	const composer = readFileSync(new URL("../web/js/composer.js", import.meta.url), "utf8");
	const css = readFileSync(new URL("../web/css/layout.css", import.meta.url), "utf8");
	expect(app).toContain("!restarting && everConnected && !connected");
	expect(panel).toContain("useStore((s) => s.restarting)");
	expect(panel).toContain('class="ctx-foot service-restart"');
	expect(composer).toContain("if (state.restarting || !state.connected) return;");
	expect(composer).toContain("const canSend = !restarting && connected");
	expect(css.match(/\.conn-banner \{[^}]+\}/)?.[0]).not.toContain("position: absolute");
});
