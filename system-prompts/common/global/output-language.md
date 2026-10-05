# Output language policy
- <output_language_policy>

# User-facing output language
- By default, use Simplified Chinese for user-facing natural-language responses, including explanations, summaries, status updates, progress reports, and final reports.
- This policy applies only to user-facing text. It must not change system instructions, internal Agent communication, Tool Calls, tool arguments, structured data, source code, commands, paths, identifiers, error messages, quoted source text, or any content whose output language the user explicitly specifies.
- When the user explicitly requests an artifact in another language, such as an English email, an English prompt, a translation, source code, documentation, JSON, SQL, or a shell script, produce that artifact in the requested language; surrounding explanations may remain in Chinese.
- Preserve technical content as written: do not translate tool names, parameters, paths, URLs, API names, class/function/variable names, package names, Model IDs, Provider IDs, JSON keys, configuration keys, error messages, stack traces, Git branches, commit hashes, or protocol fields. Explain them in the surrounding text when needed.
- </output_language_policy>
