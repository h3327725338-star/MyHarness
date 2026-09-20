import { describe, expect, it } from "vitest";
import {
	containsStaticGitExecutableInUnsupportedStructure,
	lexShellSegment,
	splitShellCommandSegments,
	stripStaticShellPrefixes,
} from "../src/utils/shell-command-lexer.ts";

function words(segment: string) {
	return lexShellSegment(segment)?.words;
}

describe("shell command lexer", () => {
	it("reconstructs one word from adjacent quoted and unquoted fragments", () => {
		expect(words('git restore "user".ts')).toEqual([
			{ value: "git", hasDynamicExpansion: false, wasQuoted: false },
			{ value: "restore", hasDynamicExpansion: false, wasQuoted: false },
			{ value: "user.ts", hasDynamicExpansion: false, wasQuoted: true },
		]);
		expect(words('git reset --ha"rd" HEAD')).toMatchObject([
			{ value: "git" },
			{ value: "reset" },
			{ value: "--hard", wasQuoted: true },
			{ value: "HEAD" },
		]);
	});

	it("applies Bash backslash and line-continuation rules", () => {
		expect(words("git restore user\\.ts")).toMatchObject([
			{ value: "git" },
			{ value: "restore" },
			{ value: "user.ts" },
		]);
		expect(words("git restore my\\ file.ts")).toMatchObject([
			{ value: "git" },
			{ value: "restore" },
			{ value: "my file.ts" },
		]);
		expect(words("git reset --ha\\\nrd HEAD")).toMatchObject([
			{ value: "git" },
			{ value: "reset" },
			{ value: "--hard" },
			{ value: "HEAD" },
		]);
		expect(words('git add "a\\q"')).toMatchObject([{ value: "git" }, { value: "add" }, { value: "a\\q" }]);
	});

	it("marks only real shell expansions as dynamic", () => {
		expect(words('git add "user-$FILE.ts"')?.[2]).toMatchObject({ hasDynamicExpansion: true });
		expect(words("git add '$FILES' '*.ts' \\*.ts")?.slice(2)).toEqual([
			{ value: "$FILES", hasDynamicExpansion: false, wasQuoted: true },
			{ value: "*.ts", hasDynamicExpansion: false, wasQuoted: true },
			{ value: "*.ts", hasDynamicExpansion: false, wasQuoted: false },
		]);
		expect(words("git add ~/file")?.[2]).toMatchObject({ hasDynamicExpansion: true });
		expect(words("git add '~/file' \"~/other\"")?.slice(2)).toEqual([
			{ value: "~/file", hasDynamicExpansion: false, wasQuoted: true },
			{ value: "~/other", hasDynamicExpansion: false, wasQuoted: true },
		]);
	});

	it("removes adjacent, separated, and descriptor redirections from argv", () => {
		expect(lexShellSegment("git clean -fd -- task-dir>clean.log")).toMatchObject({
			words: [{ value: "git" }, { value: "clean" }, { value: "-fd" }, { value: "--" }, { value: "task-dir" }],
			hasFileRedirection: true,
			hasUnresolvedRedirection: false,
		});
		expect(words("git commit -m test 2>&1 HEAD")).toMatchObject([
			{ value: "git" },
			{ value: "commit" },
			{ value: "-m" },
			{ value: "test" },
			{ value: "HEAD" },
		]);
		expect(words("git clean -fd &>> clean.log")).toMatchObject([
			{ value: "git" },
			{ value: "clean" },
			{ value: "-fd" },
		]);
	});

	it("keeps quoted and escaped redirection characters as literal words", () => {
		expect(words("git add '>file' \u005c>other \"&>both\"")).toMatchObject([
			{ value: "git" },
			{ value: "add" },
			{ value: ">file" },
			{ value: ">other" },
			{ value: "&>both" },
		]);
	});

	it("keeps unresolved here-doc and process-substitution syntax fail-closed", () => {
		expect(lexShellSegment("git clean -fd << EOF")).toMatchObject({
			words: [{ value: "git" }, { value: "clean" }, { value: "-fd" }],
			hasUnresolvedRedirection: true,
		});
		expect(lexShellSegment("git add <(command)")).toMatchObject({ hasUnresolvedRedirection: true });
		expect(lexShellSegment("git add 'unterminated")).toBeUndefined();
	});

	it("treats <(...) and >(...) as unresolved process substitution, never plain redirection", () => {
		expect(lexShellSegment("git add <(git status)")).toMatchObject({
			hasUnresolvedRedirection: true,
			hasFileRedirection: false,
		});
		expect(lexShellSegment("git add >(git reset --hard HEAD)")).toMatchObject({
			hasUnresolvedRedirection: true,
			hasFileRedirection: false,
		});
		// The whole substitution is one dynamic argv word, like Bash /dev/fd paths.
		expect(lexShellSegment("git add >(git status)")?.words).toMatchObject([
			{ value: "git" },
			{ value: "add" },
			{ value: ">(git status)", hasDynamicExpansion: true },
		]);
		// An unbalanced substitution fails closed.
		expect(lexShellSegment("git add >(git status")).toBeUndefined();
	});

	it("keeps quoted and escaped process-substitution syntax as literal arguments", () => {
		expect(lexShellSegment("git add '>(file)'")).toMatchObject({ hasUnresolvedRedirection: false });
		expect(lexShellSegment('git add ">(file)"')).toMatchObject({ hasUnresolvedRedirection: false });
		expect(lexShellSegment("git add \\>\\(file\\)")).toMatchObject({ hasUnresolvedRedirection: false });
		expect(words("git add \\>\\(file\\)")?.slice(2)).toEqual([
			{ value: ">(file)", hasDynamicExpansion: false, wasQuoted: false },
		]);
	});

	it("ends a word at an unquoted word-start # comment", () => {
		expect(words("git clean -fd # comment")).toEqual([
			{ value: "git", hasDynamicExpansion: false, wasQuoted: false },
			{ value: "clean", hasDynamicExpansion: false, wasQuoted: false },
			{ value: "-fd", hasDynamicExpansion: false, wasQuoted: false },
		]);
	});

	it("keeps # inside words, quotes, and escapes as literal characters", () => {
		expect(words("git add file#1.txt")?.[2]).toMatchObject({ value: "file#1.txt" });
		expect(words('git add "#file"')?.[2]).toMatchObject({ value: "#file", wasQuoted: true });
		expect(words("git add '#file'")?.[2]).toMatchObject({ value: "#file", wasQuoted: true });
		expect(words("git add \\#file")?.[2]).toMatchObject({ value: "#file", wasQuoted: false });
	});

	it("applies real Bash backslash semantics to Windows-style paths", () => {
		// Forward slashes pass through unchanged.
		expect(words("git -C C:/repo/nested status")?.[2]).toMatchObject({ value: "C:/repo/nested" });
		// Unquoted backslashes escape the following character, exactly like Bash.
		expect(words("git -C C:\\repo status")?.[2]).toMatchObject({ value: "C:repo" });
		expect(words("git -C C:\\repo\\nested status")?.[2]).toMatchObject({ value: "C:reponested" });
		// Double quotes preserve backslashes before non-special characters.
		expect(words('git -C "C:\\repo" status')?.[2]).toMatchObject({ value: "C:\\repo" });
	});

	it("strips static Bash execution prefixes before executable resolution", () => {
		const strip = (segment: string) =>
			stripStaticShellPrefixes(lexShellSegment(segment)!.words).remainingWords.map((word) => word.value);
		expect(strip("! git reset --hard HEAD")).toEqual(["git", "reset", "--hard", "HEAD"]);
		expect(strip("! ! git reset --hard HEAD")).toEqual(["git", "reset", "--hard", "HEAD"]);
		expect(strip("time git reset --hard HEAD")).toEqual(["git", "reset", "--hard", "HEAD"]);
		expect(strip("time -p git reset --hard HEAD")).toEqual(["git", "reset", "--hard", "HEAD"]);
		expect(strip("! time git reset --hard HEAD")).toEqual(["git", "reset", "--hard", "HEAD"]);
		expect(strip("time ! git reset --hard HEAD")).toEqual(["git", "reset", "--hard", "HEAD"]);
		const unsupported = stripStaticShellPrefixes(lexShellSegment("time --unknown git reset --hard HEAD")!.words);
		expect(unsupported.remainingWords.map((word) => word.value)).toEqual(["git", "reset", "--hard", "HEAD"]);
		expect(unsupported.hasUnsupportedPrefix).toBe(true);
	});
});

describe("shared shell command scanner", () => {
	it("splits on ;, newline, &&, || and | while keeping quoted content intact", () => {
		const texts = (command: string) => splitShellCommandSegments(command).segments.map((item) => item.text);
		expect(texts('git status; echo "a;b"')).toEqual(["git status", 'echo "a;b"']);
		expect(texts("git status && git log -1")).toEqual(["git status", "git log -1"]);
		expect(texts("git status || git log")).toEqual(["git status", "git log"]);
		expect(texts("git status | head -5")).toEqual(["git status", "head -5"]);
		expect(texts("git status\ngit log")).toEqual(["git status", "git log"]);
	});

	it("removes word-start comments and never splits inside comment text", () => {
		const texts = (command: string) => splitShellCommandSegments(command).segments.map((item) => item.text);
		expect(texts("git status # ignored ; git reset --hard HEAD")).toEqual(["git status"]);
		expect(texts("git status # first\ngit reset --hard HEAD")).toEqual(["git status", "git reset --hard HEAD"]);
		expect(texts("git add file#1.txt")).toEqual(["git add file#1.txt"]);
		expect(texts('git add "#file"')).toEqual(['git add "#file"']);
	});

	it("distinguishes background & from &> redirection and fd duplication", () => {
		expect(splitShellCommandSegments("git reset --hard HEAD &").hasBackgroundExecution).toBe(true);
		expect(splitShellCommandSegments("git add x & git commit -m y").hasBackgroundExecution).toBe(true);
		expect(splitShellCommandSegments("git status &>out.log").hasBackgroundExecution).toBe(false);
		expect(splitShellCommandSegments("git status &>>out.log").hasBackgroundExecution).toBe(false);
		expect(splitShellCommandSegments("git commit -m test 2>&1 | tail -4").hasBackgroundExecution).toBe(false);
		expect(splitShellCommandSegments("git status <&0").hasBackgroundExecution).toBe(false);
		expect(splitShellCommandSegments("git status >&2").hasBackgroundExecution).toBe(false);
	});

	it("keeps escapes and line continuation in segment text for the word lexer", () => {
		const texts = (command: string) => splitShellCommandSegments(command).segments.map((item) => item.text);
		expect(texts("git reset --ha\\rd HEAD")).toEqual(["git reset --ha\\rd HEAD"]);
		expect(texts("git status # c\n\n git log")).toEqual(["git status", "git log"]);
		expect(splitShellCommandSegments('cat "unclosed').reason).toBe("引号没有闭合");
	});

	it("reports grouping syntax so consumers can stay conservative", () => {
		expect(splitShellCommandSegments("git status (echo hi)").segments[0]?.hasGroupingSyntax).toBe(true);
		expect(splitShellCommandSegments("{ git status; }").segments[0]?.hasGroupingSyntax).toBe(true);
		expect(splitShellCommandSegments("if true; then git status; fi").segments[0]?.hasGroupingSyntax).toBe(true);
		expect(splitShellCommandSegments('git add "(literal)"').segments[0]?.hasGroupingSyntax).toBe(false);
	});

	it("does not split on control operators inside supported substitution forms", () => {
		for (const command of [
			"git commit -F <(printf 'msg\\n'; true)",
			"git commit -m $(printf x; true)",
			"git commit -m `printf x; true`",
			'git commit -m $(printf "$(echo x; true)")',
		]) {
			expect(splitShellCommandSegments(command).segments, command).toHaveLength(1);
		}
	});

	it("collects execution substitutions with Bash quote semantics", () => {
		expect(splitShellCommandSegments("echo $(git status)").executionSubstitutions).toEqual([
			{ kind: "command", body: "git status" },
		]);
		expect(splitShellCommandSegments('echo "$(git status)"').executionSubstitutions).toEqual([
			{ kind: "command", body: "git status" },
		]);
		expect(splitShellCommandSegments("echo '$(git status)'").executionSubstitutions).toEqual([]);
		expect(splitShellCommandSegments("echo `git status`").executionSubstitutions).toEqual([
			{ kind: "backtick", body: "git status" },
		]);
		expect(splitShellCommandSegments('echo "`git status`"').executionSubstitutions).toEqual([
			{ kind: "backtick", body: "git status" },
		]);
		expect(splitShellCommandSegments("cat <(git status)").executionSubstitutions).toEqual([
			{ kind: "process-input", body: "git status" },
		]);
		expect(splitShellCommandSegments("true >(git status)").executionSubstitutions).toEqual([
			{ kind: "process-output", body: "git status" },
		]);
		expect(splitShellCommandSegments("echo '<(git status)' '>(git status)'").executionSubstitutions).toEqual([]);
		expect(splitShellCommandSegments('echo "<(git status)" ">(git status)"').executionSubstitutions).toEqual([]);
		expect(splitShellCommandSegments("echo \\$\\(git status\\)").executionSubstitutions).toEqual([]);
	});

	it("keeps nested substitutions and their control operators inside the outer segment", () => {
		const controlOperators = splitShellCommandSegments("echo $(printf x; git status && true | cat)");
		expect(controlOperators.segments).toHaveLength(1);
		expect(controlOperators.executionSubstitutions).toEqual([
			{ kind: "command", body: "printf x; git status && true | cat" },
		]);

		const nested = splitShellCommandSegments('echo "$(printf \'%s\' "$(git status)")"');
		expect(nested.segments).toHaveLength(1);
		expect(nested.executionSubstitutions).toEqual([{ kind: "command", body: "printf '%s' \"$(git status)\"" }]);
	});

	it("finds only statically visible Git words for unsupported-structure blocking", () => {
		expect(containsStaticGitExecutableInUnsupportedStructure("(git reset --hard HEAD)")).toBe(true);
		expect(containsStaticGitExecutableInUnsupportedStructure("{ git.exe status; }")).toBe(true);
		expect(containsStaticGitExecutableInUnsupportedStructure("(node script.js)")).toBe(false);
		expect(containsStaticGitExecutableInUnsupportedStructure("(echo $GIT)")).toBe(false);
		expect(containsStaticGitExecutableInUnsupportedStructure("(echo x # git reset --hard HEAD)")).toBe(false);
	});
});

describe("heredoc command scanning", () => {
	const scan = (command: string) => splitShellCommandSegments(command);
	const texts = (command: string) => scan(command).segments.map((segment) => segment.text);

	it("recognizes attached and separated << / <<- redirects without changing here-strings", () => {
		for (const header of ["cat <<EOF", "cat << EOF", "cat <<-EOF", "cat <<- EOF"]) {
			const result = scan(`${header}\nbody\nEOF\ngit status`);
			expect(result.reason, header).toBeUndefined();
			expect(
				result.segments.map((segment) => segment.text),
				header,
			).toEqual([header, "git status"]);
		}
		expect(texts("cat <<<input\ngit status")).toEqual(["cat <<<input", "git status"]);
		expect(scan("cat <(git status)").executionSubstitutions).toEqual([{ kind: "process-input", body: "git status" }]);
	});

	it("removes quotes from delimiter fragments and suppresses expansion when any fragment is quoted", () => {
		for (const header of ["cat <<'EOF'", 'cat <<"EOF"', "cat <<\\EOF", 'cat <<E"OF"', "cat <<'E'OF"]) {
			const result = scan(`${header}\n$(git reset --hard HEAD)\nEOF`);
			expect(result.reason, header).toBeUndefined();
			expect(result.executionSubstitutions, header).toEqual([]);
			expect(
				result.segments.map((segment) => segment.text),
				header,
			).toEqual([header]);
		}
		const literalParameterDelimiter = scan("cat <<$EOF\nbody\n$EOF");
		expect(literalParameterDelimiter.reason).toBeUndefined();
		expect(literalParameterDelimiter.segments.map((segment) => segment.text)).toEqual(["cat <<$EOF"]);
	});

	it("consumes multiple heredocs in declaration order without exposing body commands as segments", () => {
		const result = scan("cat <<A <<B\none; hidden | body && text || more & data\nA\ntwo\nB\ngit status");
		expect(result.reason).toBeUndefined();
		expect(result.hasBackgroundExecution).toBe(false);
		expect(result.segments.map((segment) => segment.text)).toEqual(["cat <<A <<B", "git status"]);
		expect(result.executionSubstitutions).toEqual([]);
	});

	it("uses heredoc expansion context where # and ordinary quotes are data", () => {
		const result = scan(
			"cat <<EOF\n# $(git reset --hard HEAD)\n'$(git status)'\n\"$(git rev-parse HEAD)\"\n`git log -1`\nEOF",
		);
		expect(result.reason).toBeUndefined();
		expect(result.executionSubstitutions).toEqual([
			{ kind: "command", body: "git reset --hard HEAD" },
			{ kind: "command", body: "git status" },
			{ kind: "command", body: "git rev-parse HEAD" },
			{ kind: "backtick", body: "git log -1" },
		]);
	});

	it("keeps escaped command and backtick substitutions literal in an expanding body", () => {
		const result = scan("cat <<EOF\n\\$(git reset --hard HEAD)\n\\`git reset --hard HEAD\\`\nEOF");
		expect(result.reason).toBeUndefined();
		expect(result.executionSubstitutions).toEqual([]);
	});

	it("matches delimiters exactly and strips only leading TABs for <<-", () => {
		const exact = scan("cat <<EOF\nfirst\nEOF \n$(git status)\n EOF\n$(git log -1)\nEOF\ngit status");
		expect(exact.reason).toBeUndefined();
		expect(exact.executionSubstitutions).toEqual([
			{ kind: "command", body: "git status" },
			{ kind: "command", body: "git log -1" },
		]);
		expect(exact.segments.map((segment) => segment.text)).toEqual(["cat <<EOF", "git status"]);

		const stripTabs = scan("cat <<-EOF\n\t$(git status)\n EOF\n\t$(git log -1)\n\tEOF\ngit status");
		expect(stripTabs.reason).toBeUndefined();
		expect(stripTabs.executionSubstitutions).toEqual([
			{ kind: "command", body: "git status" },
			{ kind: "command", body: "git log -1" },
		]);
		expect(stripTabs.segments.map((segment) => segment.text)).toEqual(["cat <<-EOF", "git status"]);
	});

	it("collects only substitutions from expanding members of mixed multiple heredocs", () => {
		const quotedFirst = scan("cat <<'A' <<B\n$(git reset --hard HEAD)\nA\n$(git status)\nB");
		expect(quotedFirst.executionSubstitutions).toEqual([{ kind: "command", body: "git status" }]);

		const quotedSecond = scan("cat <<A <<'B'\n$(git rev-parse HEAD)\nA\n$(git reset --hard HEAD)\nB");
		expect(quotedSecond.executionSubstitutions).toEqual([{ kind: "command", body: "git rev-parse HEAD" }]);
	});

	it("reports an unterminated heredoc after collecting executable body substitutions", () => {
		const expanding = scan("cat <<EOF\n# $(git reset --hard HEAD)");
		expect(expanding.reason).toBe("Heredoc delimiter EOF 没有闭合");
		expect(expanding.executionSubstitutions).toEqual([{ kind: "command", body: "git reset --hard HEAD" }]);

		const quoted = scan("cat <<'EOF'\n$(git reset --hard HEAD)");
		expect(quoted.reason).toBe("Heredoc delimiter EOF 没有闭合");
		expect(quoted.executionSubstitutions).toEqual([]);
	});
});
