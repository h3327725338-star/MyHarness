import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-pinned-deps.mjs", import.meta.url));

function checkManifests(manifests) {
	const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "pinned-deps-"));
	for (const [path, dependencies] of Object.entries(manifests)) {
		const file = join(root, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ dependencies }));
	}
	const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
	assert.ifError(result.error);
	return result;
}

test("ignores root runtime data without changing exact-version validation", () => {
	const result = checkManifests({
		"package.json": { semver: "7.8.5" },
		"packages/example/package.json": { ws: "8.21.0" },
		"data/workspaces/session/artifacts/temporary/inspection/package.json": {
			"electron-updater": "^6.8.9",
			semver: "^7.8.5",
			ws: "^8.21.0",
		},
	});
	assert.equal(result.status, 0, result.stderr);
});

test("still rejects unpinned repository dependencies at root and in nested packages", () => {
	const result = checkManifests({
		"package.json": { semver: "^7.8.5" },
		"packages/example/package.json": { ws: "~8.21.0" },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /dependencies\.semver must be pinned, found \^7\.8\.5/);
	assert.match(result.stderr, /dependencies\.ws must be pinned, found ~8\.21\.0/);
});

test("does not exclude repository packages merely named data", () => {
	const result = checkManifests({
		"packages/data/package.json": { ws: "^8.21.0" },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /dependencies\.ws must be pinned, found \^8\.21\.0/);
});
