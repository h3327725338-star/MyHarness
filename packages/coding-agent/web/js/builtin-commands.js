// How the Web UI runs each built-in slash command. The commands themselves (names, aliases, descriptions and which
// interface offers them) come from the one registry in src/startup/slash-commands.ts, delivered by GET /api/resources;
// this table only says what a command does in the browser. test/web-frontend-logic.test.ts checks that every command
// the registry offers to the Web has an entry here and that nothing here is missing from the registry.
//
//   panel   opens the inline command panel above the composer (several levels of choices, all keyboard driven)
//   action  runs at once (see COMMAND_ACTIONS in actions.js)
//   prompt  is sent to the agent as the message; the server expands it (same as the terminal UI)
export const BUILTIN_COMMAND_KINDS = {
	settings: "panel",
	model: "panel",
	effort: "panel",
	git: "panel",
	restore: "panel",
	undo: "panel",
	workspace: "panel",
	new: "action",
	compact: "action",
	commit: "action",
	push: "action",
	workflow: "prompt",
	ultracode: "prompt",
};
