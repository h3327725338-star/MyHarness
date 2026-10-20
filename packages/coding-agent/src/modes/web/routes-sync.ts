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
}
