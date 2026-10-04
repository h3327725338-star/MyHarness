import { afterEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
	prompt: vi.fn(),
	sessionDispose: vi.fn(),
	servicesDispose: vi.fn(),
	bind: vi.fn(),
	subscribe: vi.fn(),
	create: vi.fn(),
	take: vi.fn(),
	write: vi.fn(),
	flush: vi.fn(),
	restore: vi.fn(),
}));
vi.mock("../src/platform/process/output-guard.ts", () => ({
	takeOverStdout: fx.take,
	writeRawStdout: fx.write,
	flushRawStdout: fx.flush,
	restoreStdout: fx.restore,
}));
vi.mock("../src/config/settings/index.ts", () => ({ SettingsManager: { create: vi.fn(() => ({})) } }));
vi.mock("../src/providers/runtime/model-resolver.ts", () => ({
	resolveCliModel: () => ({ model: { id: "fixture" } }),
}));
vi.mock("../src/session/manager/index.ts", () => ({ SessionManager: { inMemory: () => ({}) } }));
vi.mock("../src/agent/runtime/services.ts", () => ({
	createAgentSessionServices: fx.create,
	createAgentSessionFromServices: async () => ({
		session: { prompt: fx.prompt, dispose: fx.sessionDispose, bindExtensions: fx.bind, subscribe: fx.subscribe },
	}),
}));

import { runDelegatedWorker } from "../src/agent/delegation/worker.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});
function prepare() {
	fx.create.mockResolvedValue({ modelRuntime: {}, dispose: fx.servicesDispose });
	fx.prompt.mockResolvedValue(undefined);
	vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
		yield "delegated ";
		yield "prompt";
	});
	fx.subscribe.mockImplementation((listener) => listener({ type: "agent_end", messages: [] }));
}
describe("internal delegated worker", () => {
	it("uses shared runtime, delegated role and NDJSON without terminal input prompts", async () => {
		prepare();
		await runDelegatedWorker(["--model", "fixture", "--tools", "read"]);
		expect(fx.create.mock.calls[0][0].resourceLoaderOptions).toMatchObject({
			noExtensions: true,
			noContextFiles: true,
			agentRole: "delegated",
		});
		expect(fx.prompt).toHaveBeenCalledWith("delegated prompt");
		expect(fx.write).toHaveBeenCalledWith('{"type":"agent_end","messages":[]}\n');
		expect(fx.sessionDispose).toHaveBeenCalledOnce();
		expect(fx.servicesDispose).toHaveBeenCalledOnce();
		expect(fx.flush).toHaveBeenCalledOnce();
		expect(fx.restore).toHaveBeenCalledOnce();
	});
	it("releases session/services and output ownership when generation fails", async () => {
		prepare();
		fx.prompt.mockRejectedValueOnce(new Error("fixture failure"));
		await expect(runDelegatedWorker(["--model", "fixture"])).rejects.toThrow("fixture failure");
		expect(fx.sessionDispose).toHaveBeenCalledOnce();
		expect(fx.servicesDispose).toHaveBeenCalledOnce();
		expect(fx.restore).toHaveBeenCalledOnce();
	});
});
