import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatBalance,
	getBalance,
	startBalancePolling,
	stopBalancePolling,
	supportsBalanceTracking,
} from "../src/providers/runtime/balance-tracker.ts";

afterEach(() => {
	stopBalancePolling("main");
	stopBalancePolling("vision");
	vi.unstubAllGlobals();
});

describe("balance tracker scopes", () => {
	it("keeps main and vision balances independent", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const authorization = new Headers(init?.headers).get("Authorization");
				const totalBalance = authorization === "Bearer vision-key" ? "2.50" : "5.23";
				return new Response(
					JSON.stringify({
						is_available: true,
						balance_infos: [
							{
								currency: "CNY",
								total_balance: totalBalance,
								topped_up_balance: totalBalance,
								granted_balance: "0",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		startBalancePolling("deepseek", "main-key", "https://main.example", "main");
		startBalancePolling("deepseek", "vision-key", "https://vision.example", "vision");

		await vi.waitFor(() => {
			expect(getBalance("main")?.totalBalance).toBe("5.23");
			expect(getBalance("vision")?.totalBalance).toBe("2.50");
		});

		stopBalancePolling("main");
		expect(getBalance("main")).toBeNull();
		expect(getBalance("vision")?.totalBalance).toBe("2.50");
	});

	it("refreshes the current balance and clears it after a failed refresh", async () => {
		let callCount = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				callCount += 1;
				if (callCount === 1) {
					return new Response(
						JSON.stringify({
							is_available: true,
							balance_infos: [{ currency: "CNY", total_balance: "5.23" }],
						}),
						{ status: 200 },
					);
				}
				if (callCount === 2) {
					return new Response(
						JSON.stringify({
							is_available: true,
							balance_infos: [{ currency: "CNY", total_balance: "5.22" }],
						}),
						{ status: 200 },
					);
				}
				return new Response(null, { status: 503 });
			}),
		);

		startBalancePolling("deepseek", "main-key", "https://main.example", "main");
		await vi.waitFor(() => expect(getBalance("main")?.totalBalance).toBe("5.23"));

		await new Promise((resolve) => setTimeout(resolve, 5_100));
		await vi.waitFor(() => expect(getBalance("main")?.totalBalance).toBe("5.22"));

		await new Promise((resolve) => setTimeout(resolve, 5_100));
		await vi.waitFor(() => expect(getBalance("main")).toBeNull());
	});

	it("aborts an in-flight request when polling stops", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init?: RequestInit) => {
				requestSignal = init?.signal ?? undefined;
				return new Promise<Response>(() => {});
			}),
		);

		startBalancePolling("deepseek", "main-key", "https://main.example", "main");
		await vi.waitFor(() => expect(requestSignal).toBeDefined());
		expect(requestSignal?.aborted).toBe(false);

		stopBalancePolling("main");
		expect(requestSignal?.aborted).toBe(true);
	});

	it("no longer recognizes SiliconFlow API host for balance", () => {
		expect(supportsBalanceTracking("my-custom-provider", "https://api.siliconflow.cn/v1")).toBe(false);
	});

	it("does not send a balance request for an unsupported provider", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		expect(startBalancePolling("unknown", "secret", "https://example.test/v1")).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(getBalance("main")).toBeNull();
	});

	it("formats known currencies without assuming unknown ones are CNY", () => {
		expect(formatBalance({ totalBalance: "12.34", currency: "CNY" })).toBe("¥12.34");
		expect(formatBalance({ totalBalance: "12.34", currency: "USD" })).toBe("$12.34");
		expect(formatBalance({ totalBalance: "12.34", currency: "" })).toBe("12.34");
	});
});
