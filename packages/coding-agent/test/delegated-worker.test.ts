import { afterEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
	prompt: vi.fn(),
	steer: vi.fn(),
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
		session: {
			prompt: fx.prompt,
			steer: fx.steer,
			dispose: fx.sessionDispose,
			bindExtensions: fx.bind,
			subscribe: fx.subscribe,
		},
	}),
}));

import { parseDelegatedWorkerLine, runDelegatedWorker } from "../src/agent/delegation/worker.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});
function prepare(stdinLines: string[]) {
	fx.create.mockResolvedValue({ modelRuntime: {}, dispose: fx.servicesDispose });
	fx.prompt.mockResolvedValue(undefined);
	fx.steer.mockResolvedValue(undefined);
	vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
		for (const line of stdinLines) yield `${line}\n`;
	});
	fx.subscribe.mockImplementation((listener) => listener({ type: "agent_end", messages: [] }));
}
const promptLine = (text: string) => JSON.stringify({ type: "prompt", text });
const steerLine = (text: string) => JSON.stringify({ type: "steer", text });

describe("delegated worker stdin protocol parsing", () => {
	it("accepts prompt and steer lines and ignores anything else", () => {
		expect(parseDelegatedWorkerLine(promptLine("inspect"))).toEqual({ type: "prompt", text: "inspect" });
		expect(parseDelegatedWorkerLine(steerLine("reminder"))).toEqual({ type: "steer", text: "reminder" });
		expect(parseDelegatedWorkerLine("not json")).toBeUndefined();
		expect(parseDelegatedWorkerLine(JSON.stringify({ type: "other", text: "x" }))).toBeUndefined();
		expect(parseDelegatedWorkerLine(JSON.stringify({ type: "prompt", text: "  " }))).toBeUndefined();
		expect(parseDelegatedWorkerLine("")).toBeUndefined();
	});
});

describe("internal delegated worker", () => {
	it("uses shared runtime, delegated role and NDJSON without terminal input prompts", async () => {
		prepare([promptLine("delegated prompt")]);
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
	it("delivers steer lines as real steering messages alongside the prompt", async () => {
		prepare([promptLine("inspect the repo"), steerLine("收敛提醒：请换用其他工具")]);
		await runDelegatedWorker(["--model", "fixture", "--tools", "read"]);
		expect(fx.steer).toHaveBeenCalledWith("收敛提醒：请换用其他工具");
		expect(fx.prompt).toHaveBeenCalledWith("inspect the repo");
	});
	it("falls back to plain pre-protocol task text when no prompt line ever arrives", async () => {
		prepare(["Inspect the project.", "Report the first file."]);
		await runDelegatedWorker(["--model", "fixture", "--tools", "read"]);
		expect(fx.prompt).toHaveBeenCalledWith("Inspect the project.\nReport the first file.");
	});
	it("does not turn unparseable protocol-looking input into a prompt", async () => {
		prepare(['{"type": "prompt", "text": truncated']);
		await runDelegatedWorker(["--model", "fixture", "--tools", "read"]);
		expect(fx.prompt).not.toHaveBeenCalled();
	});
	it("releases session/services and output ownership when generation fails", async () => {
		prepare([promptLine("delegated prompt")]);
		fx.prompt.mockRejectedValueOnce(new Error("fixture failure"));
		await expect(runDelegatedWorker(["--model", "fixture"])).rejects.toThrow("fixture failure");
		expect(fx.sessionDispose).toHaveBeenCalledOnce();
		expect(fx.servicesDispose).toHaveBeenCalledOnce();
		expect(fx.restore).toHaveBeenCalledOnce();
	});
});
