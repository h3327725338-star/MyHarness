import { readFileSync } from "node:fs";
import type { AssistantMessage } from "@myharness/ai";
import { writeFileAtomically } from "../../utils/atomic-write.ts";

/**
 * What this computer has spent on each provider, estimated from the prices in models.json and the token counts the
 * provider reported. A provider without a balance API (Nebius Token Factory) can show this next to a link to its
 * console. It is an estimate: the provider's own bill is what counts.
 *
 * Every model request of the process ends here (ModelRuntime.stream / streamSimple), so chats, sub-agents and
 * background jobs all count. The file is `provider-spend.json` next to models.json; writes are batched.
 */
export interface ProviderSpend {
	/** Total of `usage.cost.total`, in `currency`. */
	total: number;
	currency: string;
	requests: number;
	/** When counting started for this provider (ISO time). */
	since: string;
}

interface SpendFile {
	version: 1;
	providers: Record<string, ProviderSpend>;
}

const SAVE_DELAY_MS = 2_000;
const ledgers = new Map<string, ProviderSpendLedger>();

/** The one ledger of a file, shared by every runtime of the process. */
export function providerSpendLedger(file: string): ProviderSpendLedger {
	let ledger = ledgers.get(file);
	if (!ledger) {
		ledger = new ProviderSpendLedger(file);
		ledgers.set(file, ledger);
	}
	return ledger;
}

export class ProviderSpendLedger {
	private readonly file: string;
	private data: SpendFile | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private saving: Promise<void> = Promise.resolve();

	constructor(file: string) {
		this.file = file;
	}

	private load(): SpendFile {
		if (this.data) return this.data;
		let providers: Record<string, ProviderSpend> = {};
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SpendFile>;
			if (parsed && typeof parsed.providers === "object" && parsed.providers) {
				for (const [id, value] of Object.entries(parsed.providers)) {
					if (value && Number.isFinite(value.total) && typeof value.since === "string") providers[id] = value;
				}
			}
		} catch {
			providers = {};
		}
		this.data = { version: 1, providers };
		return this.data;
	}

	/** Count one finished request. Requests without a cost (no price configured, aborted before any usage) are skipped. */
	record(provider: string, message: Pick<AssistantMessage, "usage">, currency = "USD"): void {
		const cost = message.usage?.cost?.total;
		if (!provider || typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return;
		const data = this.load();
		const current = data.providers[provider];
		data.providers[provider] = current
			? { ...current, total: current.total + cost, requests: current.requests + 1 }
			: { total: cost, currency, requests: 1, since: new Date().toISOString() };
		this.scheduleSave();
	}

	get(provider: string): ProviderSpend | undefined {
		const value = this.load().providers[provider];
		return value ? { ...value } : undefined;
	}

	/** Start counting again from zero for one provider. */
	reset(provider: string): void {
		const data = this.load();
		if (!data.providers[provider]) return;
		delete data.providers[provider];
		this.scheduleSave();
	}

	/** Write pending changes now (shutdown, tests). */
	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
			this.save();
		}
		await this.saving;
	}

	private scheduleSave(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.save();
		}, SAVE_DELAY_MS);
		this.timer.unref?.();
	}

	private save(): void {
		const text = `${JSON.stringify(this.load(), null, 2)}\n`;
		this.saving = this.saving
			.then(() => writeFileAtomically(this.file, text))
			.catch(() => {
				// An estimate that could not be written is lost; requests are never affected.
			});
	}
}
