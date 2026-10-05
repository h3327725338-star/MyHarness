import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { writeFileAtomicallySync } from "../utils/atomic-write.ts";
import type { ChatMode } from "./types.ts";

export interface ModeModelSelection {
	provider: string;
	id: string;
}

export interface ChatDraft {
	text: string;
	/** Frontend attachment descriptors, restored without adding them to model context. */
	attachments: Record<string, unknown>[];
}

export interface ModeState {
	lastSessionFile: string | null;
	model: ModeModelSelection | null;
	drafts: Record<string, ChatDraft>;
}

interface StoredModeState {
	version: 1;
	coding: ModeState;
	general: ModeState;
	generalPersonalPrompt: string;
}

const emptyState = (): ModeState => ({ lastSessionFile: null, model: null, drafts: {} });

function validState(state: ModeState | undefined): boolean {
	return (
		!!state &&
		(state.lastSessionFile === null || typeof state.lastSessionFile === "string") &&
		(state.model === null || (typeof state.model?.provider === "string" && typeof state.model?.id === "string")) &&
		!!state.drafts &&
		typeof state.drafts === "object" &&
		!Array.isArray(state.drafts) &&
		Object.values(state.drafts).every(
			(draft) => !!draft && typeof draft.text === "string" && Array.isArray(draft.attachments),
		)
	);
}

/** Local product preferences, not agent messages, credentials, or a second Settings system. */
export class ModeStateStore {
	private readonly path: string;

	constructor(agentDir: string) {
		this.path = join(agentDir, "chat-mode-state.json");
	}

	private read(): StoredModeState {
		if (!existsSync(this.path)) {
			return { version: 1, coding: emptyState(), general: emptyState(), generalPersonalPrompt: "" };
		}
		const value = JSON.parse(readFileSync(this.path, "utf8")) as StoredModeState;
		if (
			value.version !== 1 ||
			!validState(value.coding) ||
			!validState(value.general) ||
			typeof value.generalPersonalPrompt !== "string"
		) {
			throw new Error("Invalid chat mode state; existing file was not overwritten.");
		}
		return value;
	}

	private mutate(action: (value: StoredModeState) => void): StoredModeState {
		mkdirSync(dirname(this.path), { recursive: true });
		const release = lockfile.lockSync(dirname(this.path), { realpath: false, lockfilePath: `${this.path}.lock` });
		try {
			const value = this.read();
			action(value);
			this.save(value);
			return value;
		} finally {
			release();
		}
	}

	private save(value: StoredModeState): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileAtomicallySync(this.path, `${JSON.stringify(value, null, 2)}\n`);
	}

	get(mode: ChatMode): ModeState {
		return this.read()[mode];
	}

	update(mode: ChatMode, patch: Partial<Pick<ModeState, "lastSessionFile" | "model">>): ModeState {
		return this.mutate((value) => {
			value[mode] = { ...value[mode], ...patch };
		})[mode];
	}

	setDraft(mode: ChatMode, sessionId: string, draft: ChatDraft | null): void {
		this.mutate((value) => {
			if (draft === null || (!draft.text && !draft.attachments.length)) delete value[mode].drafts[sessionId];
			else
				Object.defineProperty(value[mode].drafts, sessionId, {
					value: draft,
					enumerable: true,
					configurable: true,
					writable: true,
				});
		});
	}

	getPersonalPrompt(): string {
		return this.read().generalPersonalPrompt;
	}

	setPersonalPrompt(prompt: string): void {
		this.mutate((value) => {
			value.generalPersonalPrompt = prompt;
		});
	}
}
