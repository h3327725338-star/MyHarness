import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as undici from "undici";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_IP_FAMILY,
	DEFAULT_KEEP_ALIVE_SECONDS,
	getProviderDispatcher,
	parseIpFamily,
	parseKeepAliveSeconds,
	providerDispatcherOptions,
} from "../src/platform/process/http-dispatcher.ts";
import { ModelConfig } from "../src/providers/models/config.ts";
import { CustomProviderManager } from "../src/providers/models/custom-provider-manager.ts";

// Temporary models.json files are left in the OS temp directory (small, never the real configuration).
async function modelsJsonWith(provider: Record<string, unknown>): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "myharness-provider-connection-"));
	const path = join(directory, "models.json");
	await writeFile(path, JSON.stringify({ providers: { p: { baseUrl: "https://example.test/v1", ...provider } } }));
	return path;
}

describe("models.json keepAliveSeconds / ipFamily", () => {
	it("loads an old entry without the fields unchanged", async () => {
		const config = await ModelConfig.load(await modelsJsonWith({ api: "openai-completions" }));
		expect(config.getError()).toBeUndefined();
		const provider = config.getProvider("p");
		expect(provider?.keepAliveSeconds).toBeUndefined();
		expect(provider?.ipFamily).toBeUndefined();
	});

	it("accepts valid values, including both ends of the range and every family", async () => {
		for (const [keepAliveSeconds, ipFamily] of [
			[1, "auto"],
			[600, "ipv4"],
			[30, "ipv6"],
		] as const) {
			const config = await ModelConfig.load(await modelsJsonWith({ keepAliveSeconds, ipFamily }));
			expect(config.getError()).toBeUndefined();
			expect(config.getProvider("p")?.keepAliveSeconds).toBe(keepAliveSeconds);
			expect(config.getProvider("p")?.ipFamily).toBe(ipFamily);
		}
	});

	it.each([
		["keepAliveSeconds", 0],
		["keepAliveSeconds", -1],
		["keepAliveSeconds", 601],
		["keepAliveSeconds", 1.5],
		["keepAliveSeconds", "15"],
		["ipFamily", "ipv5"],
		["ipFamily", 4],
		["ipFamily", ""],
	])("rejects %s = %j", async (field, value) => {
		const config = await ModelConfig.load(await modelsJsonWith({ [field]: value }));
		expect(config.getError()).toContain(field);
	});

	it("is written through the provider manager and read back; invalid values are refused and the file is untouched", async () => {
		const path = await modelsJsonWith({ api: "openai-completions" });
		const manager = new CustomProviderManager(path);
		const stored = (await manager.get("p"))!;
		await manager.upsert("p", { ...stored, keepAliveSeconds: 45, ipFamily: "auto" }, "p");
		const written = JSON.parse(await readFile(path, "utf8")).providers.p;
		expect(written.keepAliveSeconds).toBe(45);
		expect(written.ipFamily).toBe("auto");
		const before = await readFile(path, "utf8");
		await expect(manager.upsert("p", { ...stored, keepAliveSeconds: 601 }, "p")).rejects.toThrow(/keepAliveSeconds/);
		expect(await readFile(path, "utf8")).toBe(before);
	});
});

describe("provider dispatcher", () => {
	it("parses the two settings strictly", () => {
		expect(parseKeepAliveSeconds(1)).toBe(1);
		expect(parseKeepAliveSeconds(600)).toBe(600);
		for (const bad of [0, -1, 601, 2.5, "10", Number.NaN, undefined])
			expect(parseKeepAliveSeconds(bad)).toBeUndefined();
		expect(parseIpFamily("ipv6")).toBe("ipv6");
		for (const bad of ["IPv4", "", 4, undefined]) expect(parseIpFamily(bad)).toBeUndefined();
	});

	it("maps keepAliveSeconds to keepAliveTimeout and ipFamily to connect.family, keeping the time limits", () => {
		const timeouts = { connectTimeoutMs: 7_000, firstByteTimeoutMs: 8_000, streamIdleTimeoutMs: 9_000 };
		const options = providerDispatcherOptions({ keepAliveSeconds: 42, ipFamily: "ipv4" }, timeouts);
		expect(options.keepAliveTimeout).toBe(42_000);
		expect(options.keepAliveMaxTimeout).toBeGreaterThanOrEqual(600_000);
		expect(options.connect).toEqual({ timeout: 7_000, family: 4 });
		expect(options.headersTimeout).toBe(8_000);
		expect(options.bodyTimeout).toBe(9_000);
		expect(providerDispatcherOptions({ ipFamily: "ipv6" }, timeouts).connect).toEqual({ timeout: 7_000, family: 6 });
		expect(providerDispatcherOptions({ ipFamily: "auto" }, timeouts).connect).toEqual({ timeout: 7_000 });
	});

	it("uses the defaults when nothing (or something invalid) is set", () => {
		const options = providerDispatcherOptions({ keepAliveSeconds: 0 });
		expect(options.keepAliveTimeout).toBe(DEFAULT_KEEP_ALIVE_SECONDS * 1000);
		const connect = options.connect as { family?: number };
		expect(connect.family).toBe(DEFAULT_IP_FAMILY === "auto" ? undefined : DEFAULT_IP_FAMILY === "ipv4" ? 4 : 6);
	});

	it("is an EnvHttpProxyAgent, so HTTP_PROXY keeps working, and one dispatcher is reused per setting", () => {
		const first = getProviderDispatcher({ keepAliveSeconds: 91, ipFamily: "ipv4" });
		expect(first).toBeInstanceOf(undici.EnvHttpProxyAgent);
		expect(getProviderDispatcher({ keepAliveSeconds: 91, ipFamily: "ipv4" })).toBe(first);
		expect(getProviderDispatcher({ keepAliveSeconds: 92, ipFamily: "ipv4" })).not.toBe(first);
		expect(getProviderDispatcher({ keepAliveSeconds: 91, ipFamily: "ipv6" })).not.toBe(first);
		// Unset and explicitly-default settings are the same configuration.
		expect(getProviderDispatcher({})).toBe(
			getProviderDispatcher({ keepAliveSeconds: DEFAULT_KEEP_ALIVE_SECONDS, ipFamily: DEFAULT_IP_FAMILY }),
		);
	});
});

const CRLF = String.fromCharCode(13, 10);
const RESPONSE = ["HTTP/1.1 200 OK", "Content-Length: 2", "", "ok"].join(CRLF);

describe("connection reuse against a local server", () => {
	const servers: Server[] = [];
	const sockets = new Set<Socket>();
	afterEach(async () => {
		for (const socket of sockets) socket.destroy();
		await Promise.all(
			servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
		);
	});

	// A bare TCP server answering like a server that sends no Keep-Alive header and never closes the connection itself,
	// so only the client's keep-alive time decides when the connection ends.
	async function start(): Promise<{ url: string; connections: () => number }> {
		let connections = 0;
		const server = createServer((socket) => {
			connections++;
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
			socket.on("data", () => socket.write(RESPONSE));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		servers.push(server);
		const { port } = server.address() as { port: number };
		return { url: `http://127.0.0.1:${port}/`, connections: () => connections };
	}

	const get = async (url: string, dispatcher: undici.Dispatcher) => {
		const { body } = await undici.request(url, { dispatcher });
		await body.text();
	};
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	it("handshakes once while requests come within the keep-alive time, and again after it", async () => {
		const { url, connections } = await start();
		// 1 s is the smallest allowed keep-alive time. Distinct from other tests' settings, so the dispatcher is fresh.
		const dispatcher = getProviderDispatcher({ keepAliveSeconds: 1, ipFamily: "ipv4" });
		await get(url, dispatcher);
		await sleep(300);
		await get(url, dispatcher);
		await sleep(300);
		await get(url, dispatcher);
		expect(connections()).toBe(1);
		await sleep(1_600);
		await get(url, dispatcher);
		expect(connections()).toBe(2);
	}, 15_000);
});
