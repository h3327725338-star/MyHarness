/**
 * Account balance tracker for providers that expose a balance API.
 *
 * Provider-specific request and response details live in adapters below.
 */

export interface BalanceInfo {
	totalBalance: string;
	currency: string;
}

export type BalanceScope = "main" | "vision";

interface BalanceState {
	currentBalance: BalanceInfo | null;
	pollingTimer: ReturnType<typeof setInterval> | null;
	refreshController: AbortController | null;
	generation: number;
}

interface BalanceProviderAdapter {
	id: string;
	matches(provider: string, baseUrl: string): boolean;
	fetchBalance(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<BalanceInfo | null>;
	pollIntervalMs: number;
}

const BALANCE_POLL_INTERVAL_MS = 5_000;
const BALANCE_REQUEST_TIMEOUT_MS = 15_000;

const balanceStates: Record<BalanceScope, BalanceState> = {
	main: {
		currentBalance: null,
		pollingTimer: null,
		refreshController: null,
		generation: 0,
	},
	vision: {
		currentBalance: null,
		pollingTimer: null,
		refreshController: null,
		generation: 0,
	},
};

function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

function matchesHost(baseUrl: string, domains: readonly string[]): boolean {
	try {
		const hostname = new URL(baseUrl).hostname.toLowerCase();
		return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
	} catch {
		return false;
	}
}

async function fetchJson(url: string, apiKey: string, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, {
		signal,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Cache-Control": "no-cache",
			Pragma: "no-cache",
		},
	});
	if (!response.ok) return null;
	return response.json();
}

async function fetchDeepSeekBalance(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<BalanceInfo | null> {
	try {
		const data = (await fetchJson(`${trimTrailingSlashes(baseUrl)}/user/balance`, apiKey, signal)) as {
			is_available: boolean;
			balance_infos: Array<{
				currency: string;
				total_balance: string;
				topped_up_balance: string;
				granted_balance: string;
			}>;
		};
		if (data?.is_available && Array.isArray(data.balance_infos) && data.balance_infos.length > 0) {
			const balance = data.balance_infos[0];
			if (typeof balance.total_balance !== "string" || typeof balance.currency !== "string") return null;
			return {
				totalBalance: balance.total_balance,
				currency: balance.currency,
			};
		}
	} catch {
		// Silently ignore errors - balance display is non-critical
	}
	return null;
}

const balanceProviderAdapters: readonly BalanceProviderAdapter[] = [
	{
		id: "deepseek",
		matches: (provider, baseUrl) =>
			provider.toLowerCase() === "deepseek" || matchesHost(baseUrl, ["api.deepseek.com", "deepseek.com"]),
		fetchBalance: fetchDeepSeekBalance,
		pollIntervalMs: BALANCE_POLL_INTERVAL_MS,
	},
];

function findBalanceProviderAdapter(provider: string, baseUrl: string): BalanceProviderAdapter | undefined {
	return balanceProviderAdapters.find((adapter) => adapter.matches(provider, baseUrl));
}

export function supportsBalanceTracking(provider: string, baseUrl?: string): boolean {
	return findBalanceProviderAdapter(provider, baseUrl ?? "") !== undefined;
}

export function getBalance(scope: BalanceScope = "main"): BalanceInfo | null {
	return balanceStates[scope].currentBalance;
}

export function formatBalance(balance: BalanceInfo): string {
	switch (balance.currency.toUpperCase()) {
		case "CNY":
		case "RMB":
			return `¥${balance.totalBalance}`;
		case "USD":
			return `$${balance.totalBalance}`;
		default:
			return balance.totalBalance;
	}
}

/**
 * Start periodic balance polling for a provider.
 */
export function startBalancePolling(
	provider: string,
	apiKey: string,
	baseUrl?: string,
	scope: BalanceScope = "main",
	onUpdate?: () => void,
): boolean {
	stopBalancePolling(scope);
	const url = baseUrl ?? "";
	const adapter = findBalanceProviderAdapter(provider, url);
	if (!adapter) return false;
	const state = balanceStates[scope];
	const generation = state.generation;
	let refreshInFlight = false;

	const refresh = async (): Promise<void> => {
		if (refreshInFlight) return;
		refreshInFlight = true;
		const controller = new AbortController();
		state.refreshController = controller;
		const timeout = setTimeout(() => controller.abort(), BALANCE_REQUEST_TIMEOUT_MS);
		try {
			const balance =
				apiKey && !controller.signal.aborted ? await adapter.fetchBalance(apiKey, url, controller.signal) : null;
			if (state.generation !== generation) return;

			const changed =
				state.currentBalance?.totalBalance !== balance?.totalBalance ||
				state.currentBalance?.currency !== balance?.currency;
			state.currentBalance = balance;
			if (changed) onUpdate?.();
		} catch {
			if (state.generation === generation && state.currentBalance !== null) {
				state.currentBalance = null;
				onUpdate?.();
			}
		} finally {
			clearTimeout(timeout);
			if (state.refreshController === controller) state.refreshController = null;
			refreshInFlight = false;
		}
	};

	void refresh().catch(() => {
		// Balance polling is best-effort. Keep a throwing UI observer or an
		// unexpected adapter failure from becoming an unhandled rejection.
	});
	state.pollingTimer = setInterval(() => {
		void refresh().catch(() => {
			// The next interval may retry; polling must not escape as a rejection.
		});
	}, adapter.pollIntervalMs);
	return true;
}

export function stopBalancePolling(scope: BalanceScope = "main"): void {
	const state = balanceStates[scope];
	state.generation += 1;
	if (state.pollingTimer) {
		clearInterval(state.pollingTimer);
		state.pollingTimer = null;
	}
	state.refreshController?.abort();
	state.refreshController = null;
	state.currentBalance = null;
}
