import { afterEach, describe, expect, it } from "vitest";

const webDir = new URL("../web/js/", import.meta.url);
const { explainDeleteFailure } = await import(new URL("git-delete.js", webDir).href);
const { setLang } = await import(new URL("lang.js", webDir).href);

afterEach(() => setLang("en"));

describe.each(["zh-CN", "en"])("Git deletion explanations (%s)", (language) => {
	it.each(["used by worktree at", "checked out at"])(
		"explains safe and forced occupied-branch refusal (%s), including non-English paths",
		(reason) => {
			setLang(language);
			const detail = `error: cannot delete branch '任务分支' ${reason} 'C:/副本目录/task-copy'`;
			const safe = explainDeleteFailure({ detail }, "branch", false);
			const forced = explainDeleteFailure({ detail }, "branch", true);
			for (const result of [safe, forced]) {
				expect(result).toMatchObject({ canForce: true, occupied: true, worktreePath: "C:/副本目录/task-copy" });
				expect(result.message).not.toContain("error:");
				expect(result.message).toContain(language === "en" ? "permanently discard" : "永久丢失");
			}
			expect(safe.message).toBe(forced.message);
			expect(safe.message).toContain("Worktree");
		},
	);

	it("explains unmerged commits and dirty copies with the correct separate force action", () => {
		setLang(language);
		const branch = explainDeleteFailure({ detail: "error: The branch 'snapshot' is not fully merged." }, "branch");
		expect(branch.canForce).toBe(true);
		expect(branch.message).toContain(language === "en" ? "Force delete branch" : "强制删除分支");
		const copy = explainDeleteFailure(
			{
				detail:
					"删除 Worktree 失败：fatal: 'C:/副本' contains modified or untracked files, use --force to delete it",
			},
			"copy",
		);
		expect(copy.canForce).toBe(true);
		expect(copy.message).toContain(language === "en" ? "Force delete copy" : "强制删除副本");
		const forced = explainDeleteFailure({ detail: "modified or untracked files" }, "copy", true);
		expect(forced.message).toContain(language === "en" ? "did not complete" : "没成功");
	});

	it.each([
		{ detail: "Permission denied", expected: ["access permissions", "访问权限"] },
		{ detail: "fatal: worktree is locked", expected: ["locked", "锁住"] },
		{ detail: "Cannot reach the MyHarness server.", expected: ["Reconnect", "重新连接"] },
		{ detail: "Unknown worktree", expected: ["reopen", "重新打开"] },
		{ detail: 'Branch "gone" does not exist.', expected: ["reopen", "重新打开"] },
		{
			detail: "不能删除当前正在使用的 Worktree，请先进入 main 或其他 Worktree。",
			expected: ["Return", "回到主副本"],
		},
		{ detail: "The main worktree cannot be deleted.", expected: ["Return", "回到主副本"] },
		{ detail: "当前会话正在运行，请等待完成后再操作 Worktree。", expected: ["Wait", "等它完成"] },
		{ detail: "arbitrary failure with no identifiable cause", expected: ["Error details", "错误详情"] },
	])("never offers force for non-overridable/unknown failures ($detail)", ({ detail, expected }) => {
		setLang(language);
		for (const kind of ["branch", "copy"]) {
			const result = explainDeleteFailure({ detail }, kind, true);
			expect(result.canForce).not.toBe(true);
			expect(result.message).toContain(expected[language === "en" ? 0 : 1]);
			expect(result.message).not.toBe(detail);
		}
	});

	it("does not confuse branch/path text with deletion permissions or override HTTP guards", () => {
		setLang(language);
		for (const name of ["locked-task", "not trusted", "当前正在使用的副本", "Unknown worktree", "task is running"]) {
			expect(
				explainDeleteFailure(
					{ detail: `fatal: 'C:/copies/${name}' contains modified or untracked files, use --force to delete it` },
					"copy",
				).canForce,
			).toBe(true);
			expect(
				explainDeleteFailure({ detail: `error: The branch '${name}' is not fully merged.` }, "branch").canForce,
			).toBe(true);
		}
		for (const name of ["not fully merged", "use --force", "used by worktree at"])
			expect(explainDeleteFailure({ detail: `fatal: '${name}': unknown cause` }, "copy").canForce).not.toBe(true);
		for (const status of [403, 409])
			expect(explainDeleteFailure({ detail: "not fully merged; use --force", status }, "branch").canForce).not.toBe(
				true,
			);
	});

	it("uses HTTP status for busy and trust failures even when their message is translated", () => {
		setLang(language);
		const busy = explainDeleteFailure({ detail: "translated status", status: 409 }, "copy");
		expect(busy.canForce).not.toBe(true);
		expect(busy.message).toContain(language === "en" ? "Retry delete" : "重试删除");
		const trust = explainDeleteFailure({ detail: "translated status", status: 403 }, "copy");
		expect(trust.canForce).not.toBe(true);
		expect(trust.message).toContain(language === "en" ? "Settings" : "设置");
	});
});
