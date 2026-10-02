/** Terminal panel routes: the shells this computer offers, and the real shells that run in a chat's folder. */

import type { WebHost } from "./host.ts";
import type { WebHttpServer } from "./http-server.ts";
import { HttpError } from "./http-server.ts";
import type { WebTerminals } from "./terminal.ts";

/** Typed and pasted text arrives in small pieces; one piece larger than this is not something a person entered. */
const MAX_INPUT_CHARS = 1_000_000;

function asObject(body: unknown): Record<string, unknown> {
	if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
	throw new HttpError(400, "Expected a JSON object body");
}

function asString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value) throw new HttpError(400, `"${name}" must be a non-empty string`);
	return value;
}

function asSize(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1)
		throw new HttpError(400, `"${name}" must be a positive number`);
	return value;
}

export function registerTerminalRoutes(server: WebHttpServer, host: WebHost, terminals: WebTerminals): void {
	server.route("GET", "/api/terminal/shells", async () => ({ shells: await terminals.shells() }));

	// The terminal runs in the folder of the chat the request comes from; which folder that is, is not the page's choice.
	server.route("POST", "/api/terminal/open", ({ body }) => {
		const payload = asObject(body);
		return terminals.open(host.cwd, {
			shell: typeof payload.shell === "string" ? payload.shell : undefined,
			instance: typeof payload.instance === "string" ? payload.instance : undefined,
			cols: asSize(payload.cols, "cols"),
			rows: asSize(payload.rows, "rows"),
			restart: payload.restart === true,
			attached: typeof payload.attached === "string" ? payload.attached : undefined,
		});
	});

	server.route("POST", "/api/terminal/input", ({ body }) => {
		const payload = asObject(body);
		const data = asString(payload.data, "data");
		if (data.length > MAX_INPUT_CHARS) throw new HttpError(413, "Too much input at once.");
		return { ok: terminals.write(asString(payload.id, "id"), data) };
	});

	server.route("POST", "/api/terminal/resize", ({ body }) => {
		const payload = asObject(body);
		return {
			ok: terminals.resize(asString(payload.id, "id"), asSize(payload.cols, "cols"), asSize(payload.rows, "rows")),
		};
	});

	server.route("POST", "/api/terminal/close", ({ body }) => ({
		ok: terminals.close(asString(asObject(body).id, "id")),
	}));
}
