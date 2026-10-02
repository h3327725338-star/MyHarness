/**
 * Skill invocation: turning a `/skill:name args` command into the skill block
 * sent to the model, and reading such a block back from a user message.
 */

import { readFileSync } from "node:fs";
import { parseSlashCommandInvocation } from "../cli/slash-commands.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import type { Skill } from "./loader/index.ts";

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/**
 * Expand skill commands (/skill:name args) to their full content.
 * Returns the expanded text, or the original text if not a skill command or skill not found.
 * A failed file read is reported through `onReadError` and leaves the text unchanged.
 */
export function expandSkillCommand(
	text: string,
	skills: readonly Skill[],
	onReadError: (skill: Skill, error: unknown) => void,
): string {
	if (!text.startsWith("/skill:")) return text;

	const invocation = parseSlashCommandInvocation(text);
	if (!invocation || !invocation.name.startsWith("skill:")) return text;
	const skillName = invocation.name.slice(6);
	const args = invocation.args;

	const skill = skills.find((s) => s.name === skillName);
	if (!skill) return text; // Unknown skill, pass through

	try {
		const content = readFileSync(skill.filePath, "utf-8");
		const body = stripFrontmatter(content).trim();
		const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
		return args ? `${skillBlock}\n\n${args}` : skillBlock;
	} catch (err) {
		onReadError(skill, err);
		return text; // Return original on error
	}
}
