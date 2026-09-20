import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, SqliteSessionRepo } from "../../../storage/sqlite-node/src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createTempDir, createUserMessage } from "./session-test-utils.ts";

describe("sqlite-node adapter", () => {
	it("supports node:sqlite-style named parameters", async () => {
		const root = createTempDir();
		const databasePath = join(root, "adapter.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			await db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
			await db.prepare("INSERT INTO items (id, text) VALUES ($id, $text)").run({ $id: 1, $text: "hello" });
			const row = await db.prepare("SELECT text FROM items WHERE id = $id").get<{ text: string }>({ $id: 1 });
			expect(row).toEqual({ text: "hello" });
		} finally {
			await db.close();
		}
	});

	it("generates unique short entry ids from the random uuidv7 tail", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepo({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "sessions.sqlite"),
		});
		const session = await repo.create({ cwd: root });
		const storage = session.getStorage() as { cleanup?: () => Promise<void> };

		try {
			const ids: string[] = [];
			for (let index = 0; index < 5; index++) {
				ids.push(await session.appendMessage(createUserMessage(`message-${index}`)));
			}

			expect(new Set(ids).size).toBe(ids.length);
			for (const id of ids) {
				expect(id).toMatch(/^[0-9a-f]{8}$/);
			}
		} finally {
			// Release the SQLite handle so the temp directory can be removed on Windows.
			await storage.cleanup?.();
		}
	});
});
