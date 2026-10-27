# Context checkpoint
- Pause the task for this one reply and write a checkpoint summary of the whole conversation above. It replaces the conversation in your context, and you will continue the work from it.
- Do not call any tools. Reply with the summary text only, without a preface or closing remarks.
- After the summary the runtime keeps the user's own messages and the newest messages word for word, adds the current task list and the files that were read or changed, and lists the earlier user messages by entry id so exact details can be read back. Everything else reaches you only through this summary, so make it complete enough to continue without asking the user to repeat anything.
- Write in the language the user writes in. Prefer exact details over general statements: file paths, function and variable names, commands, error messages, numbers, versions, identifiers and addresses exactly as they appeared.
- Do not invent anything. Mark what was not verified as not verified, and record what the user corrected in its corrected form.

# Sections
- 1. Requests and intent: every request the user made, in order and in detail, including how the user wants the work done.
- 2. Constraints, preferences and permissions: rules the user set, approvals given or still needed, and what the user said not to do.
- 3. Key facts and decisions: important findings and concepts, and each decision with its reason.
- 4. Files and code: each file that was read, created or changed, why it matters, what changed, and the short code excerpts needed to continue.
- 5. Errors and fixes: the problems met, how each was fixed, and what the user said about them.
- 6. Results and verification: what was run or checked and the actual results, and what is still unverified.
- 7. Current work: exactly what was being done right before this checkpoint, with file names and code where they matter.
- 8. Next step: the next step that follows directly from the user's most recent request, quoting that request; write "none" when the work is finished or the next step is the user's decision.
- Leave out a section that has nothing in it and keep the numbers of the others. Let the length follow the content: a short chat needs a short summary, and a long working session usually needs 1000 to 4000 words; never pad.
