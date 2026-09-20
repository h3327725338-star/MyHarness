import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getBalance, startBalancePolling, stopBalancePolling } from "../src/providers/runtime/balance-tracker.ts";

afterEach(() => {
	stopBalancePolling("main");
	vi.unstubAllGlobals();
});

async function seedDeepSeekBalance(): Promise<void> {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						is_available: true,
						balance_infos: [
							{
								currency: "CNY",
								total_balance: "5.23",
								topped_up_balance: "5.23",
								granted_balance: "0",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		),
	);
	startBalancePolling("deepseek", "deepseek-key", "https://api.deepseek.com", "main");
	await vi.waitFor(() => expect(getBalance("main")?.totalBalance).toBe("5.23"));
}

describe("InteractiveMode main balance tracking", () => {
	it("clears the previous provider balance when the selected model has no balance adapter", async () => {
		await seedDeepSeekBalance();
		const getAuth = vi.fn();
		const fakeThis = {
			session: {
				state: {
					model: {
						provider: "longcatai",
						id: "LongCat-2.0",
						baseUrl: "https://api.longcat.chat/openai/v1",
					},
				},
				modelRuntime: { getAuth },
			},
			ui: { requestRender: vi.fn() },
		};

		await (InteractiveMode as any).prototype.updateBalanceTracking.call(fakeThis);

		expect(getBalance("main")).toBeNull();
		expect(getAuth).not.toHaveBeenCalled();
	});

	it("does not restart polling for a model that was replaced during credential lookup", async () => {
		await seedDeepSeekBalance();
		let resolveAuth: ((value: { auth: { apiKey: string } }) => void) | undefined;
		const auth = new Promise<{ auth: { apiKey: string } }>((resolve) => {
			resolveAuth = resolve;
		});
		const fakeThis = {
			session: {
				state: {
					model: {
						provider: "deepseek",
						id: "deepseek-chat",
						baseUrl: "https://api.deepseek.com",
					},
				},
				modelRuntime: { getAuth: vi.fn(() => auth) },
			},
			ui: { requestRender: vi.fn() },
		};

		const staleUpdate = (InteractiveMode as any).prototype.updateBalanceTracking.call(fakeThis);
		fakeThis.session.state.model = {
			provider: "longcatai",
			id: "LongCat-2.0",
			baseUrl: "https://api.longcat.chat/openai/v1",
		};
		await (InteractiveMode as any).prototype.updateBalanceTracking.call(fakeThis);
		resolveAuth?.({ auth: { apiKey: "deepseek-key" } });
		await staleUpdate;

		expect(getBalance("main")).toBeNull();
	});
});
