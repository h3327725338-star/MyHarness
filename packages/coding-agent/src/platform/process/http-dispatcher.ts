import { EventEmitter } from "node:events";
import * as undici from "undici";

/**
 * The three request time limits of the global HTTP dispatcher, each independent of the others (undici options):
 * - connect: TCP + TLS handshake of a new connection (`connect.timeout`, UND_ERR_CONNECT_TIMEOUT);
 * - first byte: request sent until the response headers arrive (`headersTimeout`, UND_ERR_HEADERS_TIMEOUT);
 * - stream idle: longest gap between two pieces of response body once the headers arrived, restarted by every piece, so the
 *   total length of a stream is not limited (`bodyTimeout`, UND_ERR_BODY_TIMEOUT).
 * A dropped connection is not a limit but an event (UND_ERR_SOCKET).
 */
export interface NetworkTimeouts {
	connectTimeoutMs: number;
	firstByteTimeoutMs: number;
	streamIdleTimeoutMs: number;
}

export const DEFAULT_NETWORK_TIMEOUTS: Readonly<NetworkTimeouts> = {
	connectTimeoutMs: 10_000,
	firstByteTimeoutMs: 60_000,
	streamIdleTimeoutMs: 60_000,
};

/** Every limit is 1 second to 1 hour: zero would disable it in undici, which would bring the hung-request problem back. */
export const MIN_NETWORK_TIMEOUT_MS = 1_000;
export const MAX_NETWORK_TIMEOUT_MS = 3_600_000;

export function parseNetworkTimeoutMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const timeoutMs = Math.floor(value);
	return timeoutMs >= MIN_NETWORK_TIMEOUT_MS && timeoutMs <= MAX_NETWORK_TIMEOUT_MS ? timeoutMs : undefined;
}

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing MyHarness.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

/** How a provider's connections resolve addresses: both families (the OS default), IPv4 only or IPv6 only. */
export type IpFamily = "auto" | "ipv4" | "ipv6";
export const IP_FAMILIES: readonly IpFamily[] = ["auto", "ipv4", "ipv6"];

/**
 * Defaults of the two per-provider connection settings (models.json `keepAliveSeconds` / `ipFamily`), used when a
 * provider does not set them. Measured on 2026-10-09 against the qwen host (token-plan.cn-beijing.maas.aliyuncs.com): IPv6
 * handshakes were slow or timed out (automatic mode failed 3 of 20), IPv4 never failed; with IPv4 and a 120 s keep-alive time
 * no connection was closed by the server or re-opened at idle gaps up to 115 s (shorter times re-opened every connection
 * past their limit). Reports: data/.../artifacts/temporary/keepalive-ipfamily/REPORT.md.
 */
export const DEFAULT_KEEP_ALIVE_SECONDS = 120;
export const DEFAULT_IP_FAMILY: IpFamily = "ipv4";
export const MIN_KEEP_ALIVE_SECONDS = 1;
export const MAX_KEEP_ALIVE_SECONDS = 600;
/** Server `Keep-Alive: timeout=N` hints are honored up to this long; undici's own default, stated here so it stays. */
const KEEP_ALIVE_MAX_TIMEOUT_MS = 600_000;

export interface ProviderConnectionSettings {
	keepAliveSeconds?: number;
	ipFamily?: IpFamily;
}

/** A whole number of seconds from 1 to 600, or undefined. */
export function parseKeepAliveSeconds(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
	return value >= MIN_KEEP_ALIVE_SECONDS && value <= MAX_KEEP_ALIVE_SECONDS ? value : undefined;
}

export function parseIpFamily(value: unknown): IpFamily | undefined {
	return typeof value === "string" && (IP_FAMILIES as readonly string[]).includes(value)
		? (value as IpFamily)
		: undefined;
}

let currentTimeouts: NetworkTimeouts = DEFAULT_NETWORK_TIMEOUTS;

/** Options of the EnvHttpProxyAgent for one provider: the shared time limits plus its keep-alive time and IP family. */
export function providerDispatcherOptions(
	settings: ProviderConnectionSettings = {},
	timeouts: NetworkTimeouts = currentTimeouts,
): undici.EnvHttpProxyAgent.Options {
	const keepAliveSeconds = parseKeepAliveSeconds(settings.keepAliveSeconds) ?? DEFAULT_KEEP_ALIVE_SECONDS;
	const ipFamily = parseIpFamily(settings.ipFamily) ?? DEFAULT_IP_FAMILY;
	return {
		...baseDispatcherOptions(timeouts),
		keepAliveTimeout: keepAliveSeconds * 1000,
		keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
		connect: {
			timeout: timeouts.connectTimeoutMs,
			...(ipFamily === "auto" ? {} : { family: ipFamily === "ipv4" ? 4 : 6 }),
		},
	};
}

function baseDispatcherOptions(timeouts: NetworkTimeouts): undici.EnvHttpProxyAgent.Options {
	return {
		allowH2: false,
		bodyTimeout: timeouts.streamIdleTimeoutMs,
		headersTimeout: timeouts.firstByteTimeoutMs,
		connect: { timeout: timeouts.connectTimeoutMs },
		clientFactory: createUndiciClient,
		factory: createUndiciOriginDispatcher,
	};
}

const providerDispatchers = new Map<string, undici.Dispatcher>();

/**
 * The dispatcher for model requests of a provider with these settings. One dispatcher per distinct setting (and per time
 * limits in force), created on first use and reused afterwards, so connections are reused between requests. A changed
 * setting or time limit yields a new dispatcher; the old one is left to finish its requests and idle out.
 */
export function getProviderDispatcher(settings: ProviderConnectionSettings = {}): undici.Dispatcher {
	const keepAliveSeconds = parseKeepAliveSeconds(settings.keepAliveSeconds) ?? DEFAULT_KEEP_ALIVE_SECONDS;
	const ipFamily = parseIpFamily(settings.ipFamily) ?? DEFAULT_IP_FAMILY;
	const key = `${keepAliveSeconds}|${ipFamily}`;
	let dispatcher = providerDispatchers.get(key);
	if (!dispatcher) {
		dispatcher = withUndiciErrorListener(
			new undici.EnvHttpProxyAgent(providerDispatcherOptions({ keepAliveSeconds, ipFamily })),
		);
		providerDispatchers.set(key, dispatcher);
	}
	return dispatcher;
}

export function configureHttpDispatcher(timeouts: NetworkTimeouts = DEFAULT_NETWORK_TIMEOUTS): void {
	for (const [name, value] of Object.entries(timeouts)) {
		if (parseNetworkTimeoutMs(value) === undefined)
			throw new Error(`Invalid network timeout ${name}: ${String(value)}`);
	}
	currentTimeouts = { ...timeouts };
	// Provider dispatchers carry the time limits too: the next request builds them again with the new limits.
	providerDispatchers.clear();
	const dispatcher = withUndiciErrorListener(new undici.EnvHttpProxyAgent(baseDispatcherOptions(timeouts)));
	undici.setGlobalDispatcher(dispatcher);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}
