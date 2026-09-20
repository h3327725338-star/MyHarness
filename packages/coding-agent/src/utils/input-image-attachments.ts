import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ImageContent } from "@myharness/ai/compat";
import { preprocessLocalFile } from "./file-preprocess.ts";

function pathFromInputLine(line: string): string | undefined {
	let candidate = line.trim();
	if (candidate.startsWith("@")) candidate = candidate.slice(1).trim();
	if (
		(candidate.startsWith('"') && candidate.endsWith('"')) ||
		(candidate.startsWith("'") && candidate.endsWith("'"))
	) {
		candidate = candidate.slice(1, -1).trim();
	}
	return candidate && isAbsolute(candidate) ? candidate : undefined;
}

/**
 * Finds standalone absolute image paths in an interactive message and turns
 * them into normal image attachments. The original text is intentionally kept
 * so the model still sees any filename or surrounding user instruction.
 */
export async function collectInputImageAttachments(
	text: string,
	options: { autoResizeImages: boolean },
): Promise<ImageContent[]> {
	const images: ImageContent[] = [];
	const seen = new Set<string>();

	for (const line of text.split(/\r?\n/)) {
		const candidate = pathFromInputLine(line);
		if (!candidate) continue;
		const filePath = resolve(candidate);
		if (seen.has(filePath)) continue;
		seen.add(filePath);

		try {
			if (!(await stat(filePath)).isFile()) continue;
			const preprocessed = await preprocessLocalFile(filePath, { autoResizeImages: options.autoResizeImages });
			if (preprocessed?.kind === "image") images.push(...preprocessed.images);
		} catch {
			// Leave ordinary text paths alone when they are missing or unreadable.
		}
	}

	return images;
}
