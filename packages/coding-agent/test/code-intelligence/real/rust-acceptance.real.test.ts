import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChangeControl } from "../../../src/changes/factory.ts";
import { documentVersionLookup } from "../../../src/changes/service.ts";
import { CodeIntelligenceInstallationManager } from "../../../src/symbols/runtime/installation.ts";
import { CodeIntelligenceRuntime } from "../../../src/symbols/runtime/runtime.ts";

const installation = new CodeIntelligenceInstallationManager({});
const registry = installation.createInstalledLanguageServerRegistry();
const definition = registry?.getAll().find((server) => server.id === "managed-rust");

describe.skipIf(!definition)("real Rust project acceptance", () => {
	it("renames an unopened consumer, compiles the actual result and detects a downstream type error", async () => {
		const root = await mkdtemp(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "rust-acceptance-"));
		await mkdir(join(root, "src"));
		await writeFile(
			join(root, "Cargo.toml"),
			'[package]\nname = "acceptance"\nversion = "0.1.0"\nedition = "2021"\n',
		);
		await writeFile(join(root, "src/lib.rs"), "pub fn twice(value: i32) -> i32 { value * 2 }\n");
		await writeFile(join(root, "src/main.rs"), "fn main() { assert_eq!(acceptance::twice(21), 42); }\n");
		const runtime = new CodeIntelligenceRuntime({
			workspaceRoot: root,
			registry,
			installationManager: installation,
			agentDir: join(root, ".agent"),
		});
		try {
			const target = { type: "position" as const, path: "src/lib.rs", position: { line: 0, character: 7 } };
			const options = { mode: "semantic" as const, definitionId: "managed-rust", timeoutMs: 60_000 };
			const queryReferences = async () => {
				try {
					return await runtime.router.findReferences(target, options);
				} catch (error) {
					if ((error as { cause?: { code?: number } }).cause?.code !== -32801) throw error;
					return { items: [] };
				}
			};
			let references = await queryReferences();
			const deadline = Date.now() + 60_000;
			while (references.items.length < 2 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 200));
				references = await queryReferences();
			}
			expect(references.items.some((reference) => reference.location.path === "src/main.rs")).toBe(true);
			const renamed = await runtime.router.rename(target, "double", options);
			const control = createChangeControl({ workspaceRoot: root, agentDir: join(root, ".changes") });
			const preview = await control.previewWorkspaceEdit(renamed.items[0]!.edit, {
				description: "Rename Rust function",
				source: "rename",
				knownVersion: documentVersionLookup(renamed.items[0]!.documentVersions, root),
				rename: { oldName: "twice" },
			});
			expect(preview.changeset.files.map((file) => file.path)).toEqual(["src/lib.rs", "src/main.rs"]);
			await control.apply(preview.changeset.id, { origin: { kind: "refactor" } });
			const consumer = await readFile(join(root, "src/main.rs"), "utf8");
			expect(consumer).toContain("acceptance::double(21)");
			const shared = definition?.env?.MYHARNESS_CODE_INTELLIGENCE_SHARED_ROOTS?.split(";").find((path) =>
				path.includes("rust-toolchain"),
			);
			if (!shared) throw new Error("Managed Rust toolchain missing from registry");
			const cargoHome = join(shared, "servers/rust-toolchain/cargo");
			const rustupHome = join(shared, "servers/rust-toolchain/rustup");
			const env = {
				...process.env,
				CARGO_HOME: cargoHome,
				RUSTUP_HOME: rustupHome,
				CARGO_NET_OFFLINE: "true",
				CARGO_TARGET_DIR: join(root, "target"),
				PATH: `${join(cargoHome, "bin")};${process.env.PATH ?? ""}`,
			};
			const cargo = join(cargoHome, "bin/cargo.exe");
			const compile = () =>
				execFileSync(cargo, ["check", "--offline", "--manifest-path", join(root, "Cargo.toml")], {
					cwd: root,
					env,
					encoding: "utf8",
					stdio: "pipe",
					windowsHide: true,
				});
			expect(compile).not.toThrow();
			await writeFile(join(root, "src/main.rs"), consumer.replace("double(21)", 'double("invalid")'));
			expect(compile).toThrow();
			await writeFile(join(root, "src/main.rs"), consumer);
			expect(compile).not.toThrow();
		} finally {
			await runtime.dispose();
		}
	}, 180_000);
});
