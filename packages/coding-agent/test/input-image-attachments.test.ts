import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectInputImageAttachments } from "../src/utils/input-image-attachments.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("collectInputImageAttachments", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `myharness-input-image-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("attaches a standalone absolute PNG path from an interactive message", async () => {
		const imagePath = join(testDir, "screenshot.png");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const images = await collectInputImageAttachments(`${imagePath}\n这是什么问题？`, { autoResizeImages: true });

		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("does not attach a missing path or an ordinary text line", async () => {
		const images = await collectInputImageAttachments(`${join(testDir, "missing.png")}\n请检查这个问题`, {
			autoResizeImages: true,
		});

		expect(images).toHaveLength(0);
	});
});
