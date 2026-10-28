import type { SyncService } from "../../sync/service.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected a JSON object");
	return value as Record<string, unknown>;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new HttpError(400, `${name} must be true or false`);
	return value;
}

function optionalString(value: unknown, name: string, max = 512): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > max) throw new HttpError(400, `${name} must be a string`);
	return value;
}

/**
 * Settings and status for Google Drive sync. The background engine owns all scheduling; these routes only read its
 * state, change configuration and start the OAuth flow.
 */
export function registerSyncRoutes(server: WebHttpServer, sync: SyncService): void {
	server.route("GET", "/api/sync/state", () => ({ status: sync.status() }));

	server.route("POST", "/api/sync/config", async ({ body }) => {
		const input = object(body);
		const enabled = optionalBoolean(input.enabled, "enabled");
		const paused = optionalBoolean(input.paused, "paused");
		const clientId = optionalString(input.clientId, "clientId", 300);
		const clientSecret = optionalString(input.clientSecret, "clientSecret", 300);
		const deviceName = optionalString(input.deviceName, "deviceName", 120);
		try {
			const status = await sync.updateConfig({
				...(enabled !== undefined ? { enabled } : {}),
				...(paused !== undefined ? { paused } : {}),
				...(clientId !== undefined ? { clientId } : {}),
				...(clientSecret !== undefined ? { clientSecret } : {}),
				...(deviceName !== undefined ? { deviceName } : {}),
			});
			return { status };
		} catch (error) {
			throw new HttpError(409, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("POST", "/api/sync/connect", async () => {
		try {
			const result = await sync.connect();
			return { authUrl: result.authUrl, status: sync.status() };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("POST", "/api/sync/disconnect", async () => ({ status: await sync.disconnect() }));

	server.route("POST", "/api/sync/check", async () => {
		// Report the state after the pass: the engine records failures in lastError instead of throwing.
		await sync.runNow();
		return { status: sync.status() };
	});

	// Manual runs answer immediately; the page follows progress through the status (`manual`).
	for (const kind of ["download", "sync"] as const) {
		server.route("POST", `/api/sync/${kind}`, () => {
			try {
				return { status: sync.startManual(kind) };
			} catch (error) {
				throw new HttpError(409, error instanceof Error ? error.message : String(error));
			}
		});
	}

	server.route("POST", "/api/sync/bind", async ({ body }) => {
		const input = object(body);
		const workspaceId = optionalString(input.workspaceId, "workspaceId", 120)?.trim();
		const rootPath = optionalString(input.rootPath, "rootPath", 4096)?.trim();
		if (!workspaceId || !rootPath) throw new HttpError(400, "workspaceId and rootPath are required");
		try {
			return { status: await sync.bindWorkspace(workspaceId, rootPath) };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	// Workspace file channel: which engine owns a folder, what a first upload would send, and the conflict and
	// deletion decisions. The background engine still does all scheduling; these routes only answer a question or
	// apply one explicit choice.
	server.route("POST", "/api/sync/workspace-source", ({ body }) => {
		const input = object(body);
		const workspaceId = optionalString(input.workspaceId, "workspaceId", 120)?.trim();
		if (!workspaceId) throw new HttpError(400, "workspaceId is required");
		return { source: sync.detectWorkspaceSource(workspaceId) };
	});

	server.route("POST", "/api/sync/files/preflight", async ({ body }) => {
		const input = object(body);
		const workspaceId = optionalString(input.workspaceId, "workspaceId", 120)?.trim();
		if (!workspaceId) throw new HttpError(400, "workspaceId is required");
		return { preflight: await sync.preflightFiles(workspaceId) };
	});

	server.route("POST", "/api/sync/files/enable", async ({ body }) => {
		const input = object(body);
		const workspaceId = optionalString(input.workspaceId, "workspaceId", 120)?.trim();
		const source = optionalString(input.source, "source", 16)?.trim();
		if (!workspaceId) throw new HttpError(400, "workspaceId is required");
		if (source !== "local" && source !== "drive" && source !== "none") {
			throw new HttpError(400, "source must be local, drive or none");
		}
		const confirmed = optionalBoolean(input.confirmed, "confirmed") === true;
		const driveRootId = optionalString(input.driveRootId, "driveRootId", 200)?.trim();
		const driveRelativePath = optionalString(input.driveRelativePath, "driveRelativePath", 4096)?.trim();
		if (source === "local" && !confirmed) {
			throw new HttpError(400, "The first upload needs an explicit confirmation.");
		}
		try {
			return {
				status: await sync.enableFiles(workspaceId, source, {
					...{ confirmed },
					...(driveRootId ? { driveRootId } : {}),
					...(driveRelativePath ? { driveRelativePath } : {}),
				}),
			};
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("POST", "/api/sync/files/disable", ({ body }) => {
		const input = object(body);
		const workspaceId = optionalString(input.workspaceId, "workspaceId", 120)?.trim();
		if (!workspaceId) throw new HttpError(400, "workspaceId is required");
		try {
			return { status: sync.disableFiles(workspaceId) };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("POST", "/api/sync/files/resolve", async ({ body }) => {
		const input = object(body);
		const workspaceId = optionalString(input.workspaceId, "workspaceId", 120)?.trim();
		const conflictId = optionalString(input.conflictId, "conflictId", 200)?.trim();
		const choice = optionalString(input.choice, "choice", 20)?.trim();
		if (!workspaceId || !conflictId) throw new HttpError(400, "workspaceId and conflictId are required");
		if (choice !== "keep-local" && choice !== "take-remote" && choice !== "keep-both") {
			throw new HttpError(400, "choice must be keep-local, take-remote or keep-both");
		}
		try {
			return { status: await sync.resolveFileConflict(workspaceId, conflictId, choice) };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("POST", "/api/sync/files/confirm-deletes", async ({ body }) => {
		const input = object(body);
		const workspaceId = optionalString(input.workspaceId, "workspaceId", 120)?.trim();
		if (!workspaceId) throw new HttpError(400, "workspaceId is required");
		try {
			return { status: await sync.confirmFileDeletes(workspaceId) };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("POST", "/api/sync/occupancy", ({ body }) => {
		const input = object(body);
		const workspaceId = optionalString(input.workspaceId, "workspaceId", 120)?.trim();
		const rootPath = optionalString(input.rootPath, "rootPath", 4096)?.trim();
		if (!workspaceId || !rootPath) throw new HttpError(400, "workspaceId and rootPath are required");
		return { occupancy: sync.occupancyFor(workspaceId, rootPath) ?? null };
	});

	server.route("POST", "/api/sync/release-occupant", ({ body }) => {
		const input = object(body);
		const workspaceId = optionalString(input.workspaceId, "workspaceId", 120)?.trim();
		const confirmed = optionalBoolean(input.confirmed, "confirmed") === true;
		if (!workspaceId) throw new HttpError(400, "workspaceId is required");
		if (!confirmed) throw new HttpError(400, "Releasing the folder needs an explicit confirmation.");
		try {
			return { status: sync.releaseOccupant(workspaceId, confirmed) };
		} catch (error) {
			throw new HttpError(409, error instanceof Error ? error.message : String(error));
		}
	});

	// A restored Workspace whose folder is held by a listed one is merged into it, never bound beside it.
	server.route("POST", "/api/sync/merge-workspace", async ({ body }) => {
		const input = object(body);
		const workspaceId = optionalString(input.workspaceId, "workspaceId", 120)?.trim();
		const targetWorkspaceId = optionalString(input.targetWorkspaceId, "targetWorkspaceId", 120)?.trim();
		const confirmed = optionalBoolean(input.confirmed, "confirmed") === true;
		if (!workspaceId || !targetWorkspaceId)
			throw new HttpError(400, "workspaceId and targetWorkspaceId are required");
		if (!confirmed) throw new HttpError(400, "Merging the workspaces needs an explicit confirmation.");
		try {
			return await sync.mergeWorkspace(workspaceId, targetWorkspaceId, confirmed);
		} catch (error) {
			throw new HttpError(409, error instanceof Error ? error.message : String(error));
		}
	});
}
