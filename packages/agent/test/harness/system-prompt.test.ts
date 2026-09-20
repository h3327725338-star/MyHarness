import { describe, expect, it } from "vitest";
import { formatSkillsForSystemPrompt } from "../../src/harness/system-prompt.ts";

const visibleSkill = {
	name: "visible",
	description: "Use <this> & that",
	content: "visible content",
	filePath: "/skills/visible/SKILL.md",
};

const secondSkill = {
	name: "second",
	description: "Second skill",
	content: "second content",
	filePath: "/skills/second/SKILL.md",
};

const disabledSkill = {
	name: "hidden",
	description: "Hidden",
	content: "hidden content",
	filePath: "/skills/hidden/SKILL.md",
	disableModelInvocation: true,
};

describe("formatSkillsForSystemPrompt", () => {
	it("formats visible skills in order and skips model-disabled skills", () => {
		expect(formatSkillsForSystemPrompt([visibleSkill, disabledSkill, secondSkill])).toBe(
			`以下 skills 为特定任务提供专门指令。
当任务符合某个 skill 的描述时，读取完整的 skill 文件。
当 skill 文件引用相对路径时，将其解析为相对于 skill 目录（SKILL.md 的父目录 / 路径的 dirname）的路径，并在工具命令中使用该绝对路径。

<available_skills>
  <skill>
    <name>visible</name>
    <description>Use &lt;this&gt; &amp; that</description>
    <location>/skills/visible/SKILL.md</location>
  </skill>
  <skill>
    <name>second</name>
    <description>Second skill</description>
    <location>/skills/second/SKILL.md</location>
  </skill>
</available_skills>`,
		);
	});

	it("returns an empty string when no skills are model-visible", () => {
		expect(formatSkillsForSystemPrompt([disabledSkill])).toBe("");
	});

	it("escapes XML in all model-visible skill fields", () => {
		expect(
			formatSkillsForSystemPrompt([
				{
					name: "a&b",
					description: `Quote "double" and 'single'`,
					content: "content",
					filePath: '/skills/<bad>&"quote"/SKILL.md',
				},
			]),
		).toContain(
			"<name>a&amp;b</name>\n    <description>Quote &quot;double&quot; and &apos;single&apos;</description>\n    <location>/skills/&lt;bad&gt;&amp;&quot;quote&quot;/SKILL.md</location>",
		);
	});
});
