import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupEmptySessionDirectoriesAsync } from "../session/storage/jsonl/index.ts";
import { cleanupStaleAtomicWriteTempsAsync, writeFileAtomically } from "../utils/atomic-write.ts";

export interface DeferredMaintenanceLogger {
	info?: (message: string) => void;
	warn?: (message: string) => void;
	error?: (message: string) => void;
}

export interface DeferredMaintenanceOptions {
	dataRoot: string;
	delayMs?: number;
	intervalMs?: number;
	nowMs?: number | (() => number);
	signal?: AbortSignal;
	logger?: DeferredMaintenanceLogger;
	yieldToEventLoop?: () => Promise<void> | void;
	batchSize?: number;
}

export interface DeferredMaintenanceHandle {
	done: Promise<void>;
	cancel: () => void;
}

export interface StartupMaintenanceMarker {
	version: 1;
	tasks: {
		cleanupStaleAtomicWriteTemps?: {
			lastSuccessAt: number;
		};
		cleanupEmptySessionDirectories?: {
			lastSuccessAt: number;
		};
		[key: string]: { lastSuccessAt: number } | undefined;
	};
}

const MARKER_FILE_NAME = ".startup-maintenance.json";

function getNowMs(nowOption: number | (() => number) | undefined): number {
	if (typeof nowOption === "function") return nowOption();
	if (typeof nowOption === "number") return nowOption;
	return Date.now();
}

function readMarker(markerPath: string, currentNow: number): StartupMaintenanceMarker {
	if (!existsSync(markerPath)) {
		return { version: 1, tasks: {} };
	}
	try {
		const raw = readFileSync(markerPath, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) {
			return { version: 1, tasks: {} };
		}
		const tasksSource = typeof parsed.tasks === "object" && parsed.tasks !== null ? parsed.tasks : parsed;
		const cleanTasks: StartupMaintenanceMarker["tasks"] = {};

		for (const [taskName, taskData] of Object.entries(tasksSource)) {
			if (typeof taskData === "object" && taskData !== null) {
				const lastSuccessAt = Number((taskData as { lastSuccessAt?: unknown }).lastSuccessAt);
				// Missing, NaN, corrupt, or future timestamps are treated as never done (0)
				if (Number.isSafeInteger(lastSuccessAt) && lastSuccessAt > 0 && lastSuccessAt <= currentNow) {
					cleanTasks[taskName] = { lastSuccessAt };
				}
			}
		}

		return { version: 1, tasks: cleanTasks };
	} catch {
		return { version: 1, tasks: {} };
	}
}

async function updateMarker(
	markerPath: string,
	taskName: string,
	successAt: number,
	currentNow: number,
): Promise<void> {
	const current = readMarker(markerPath, currentNow);
	current.tasks[taskName] = { lastSuccessAt: successAt };
	const content = `${JSON.stringify(current, null, 2)}\n`;
	await writeFileAtomically(markerPath, content);
}

/**
 * Schedule deferred startup maintenance tasks to run asynchronously off the critical path.
 *
 * Runs after the specified delay, skips tasks completed within intervalMs,
 * and yields to the event loop every batch size items during traversal.
 */
export function scheduleDeferredStartupMaintenance(options: DeferredMaintenanceOptions): DeferredMaintenanceHandle {
	const {
		dataRoot,
		delayMs = 1500,
		intervalMs = 24 * 3600 * 1000,
		nowMs,
		signal: externalSignal,
		logger,
		yieldToEventLoop,
		batchSize,
	} = options;

	const resolvedDataRoot = resolve(dataRoot);
	try {
		if (!existsSync(resolvedDataRoot) || !statSync(resolvedDataRoot).isDirectory()) {
			return {
				done: Promise.resolve(),
				cancel: () => {},
			};
		}
	} catch {
		return {
			done: Promise.resolve(),
			cancel: () => {},
		};
	}

	const abortController = new AbortController();
	const onExternalAbort = () => abortController.abort();
	if (externalSignal) {
		if (externalSignal.aborted) {
			abortController.abort();
		} else {
			externalSignal.addEventListener("abort", onExternalAbort, { once: true });
		}
	}

	let timer: NodeJS.Timeout | undefined;
	let resolveDone!: () => void;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});

	let isCompleted = false;
	const complete = () => {
		if (isCompleted) return;
		isCompleted = true;
		if (externalSignal) {
			externalSignal.removeEventListener("abort", onExternalAbort);
		}
		resolveDone();
	};

	const cancel = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		abortController.abort();
		complete();
	};

	const runTasks = async (): Promise<void> => {
		if (abortController.signal.aborted) {
			complete();
			return;
		}
		const markerPath = join(resolvedDataRoot, MARKER_FILE_NAME);
		const currentNow = getNowMs(nowMs);
		const marker = readMarker(markerPath, currentNow);

		// Task 1: cleanupStaleAtomicWriteTempsAsync
		const lastAtomicAt = marker.tasks.cleanupStaleAtomicWriteTemps?.lastSuccessAt ?? 0;
		if (currentNow - lastAtomicAt >= intervalMs) {
			try {
				if (!abortController.signal.aborted) {
					await cleanupStaleAtomicWriteTempsAsync(resolvedDataRoot, {
						signal: abortController.signal,
						nowMs: currentNow,
						yieldToEventLoop,
						batchSize,
					});
					if (!abortController.signal.aborted) {
						await updateMarker(markerPath, "cleanupStaleAtomicWriteTemps", currentNow, currentNow);
					}
				}
			} catch (error) {
				logger?.error?.(
					`Deferred maintenance cleanupStaleAtomicWriteTemps failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else {
			logger?.info?.(
				`Deferred maintenance cleanupStaleAtomicWriteTemps skipped: last ran ${(currentNow - lastAtomicAt) / 1000}s ago (< ${intervalMs / 1000}s)`,
			);
		}

		// Task 2: cleanupEmptySessionDirectoriesAsync
		if (abortController.signal.aborted) {
			complete();
			return;
		}
		const lastSessionAt = marker.tasks.cleanupEmptySessionDirectories?.lastSuccessAt ?? 0;
		if (currentNow - lastSessionAt >= intervalMs) {
			try {
				if (!abortController.signal.aborted) {
					await cleanupEmptySessionDirectoriesAsync(resolvedDataRoot, {
						signal: abortController.signal,
						nowMs: currentNow,
						yieldToEventLoop,
						batchSize,
					});
					if (!abortController.signal.aborted) {
						await updateMarker(markerPath, "cleanupEmptySessionDirectories", currentNow, currentNow);
					}
				}
			} catch (error) {
				logger?.error?.(
					`Deferred maintenance cleanupEmptySessionDirectories failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else {
			logger?.info?.(
				`Deferred maintenance cleanupEmptySessionDirectories skipped: last ran ${(currentNow - lastSessionAt) / 1000}s ago (< ${intervalMs / 1000}s)`,
			);
		}

		complete();
	};

	timer = setTimeout(() => {
		void runTasks().catch((err) => {
			logger?.error?.(
				`Unexpected deferred maintenance failure: ${err instanceof Error ? err.message : String(err)}`,
			);
			complete();
		});
	}, delayMs);
	timer.unref();

	return { done, cancel };
}
