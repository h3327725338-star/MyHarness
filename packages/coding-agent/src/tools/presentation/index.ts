export { createBashToolRenderer } from "./bash.ts";
export { createEditToolRenderer } from "./edit.ts";
export { createFindToolRenderer } from "./find.ts";
export { createGrepToolRenderer } from "./grep.ts";
export { createLsToolRenderer } from "./ls.ts";
export { createPwshToolRenderer } from "./pwsh.ts";
export { createReadToolRenderer } from "./read.ts";
export { createSubAgentToolRenderer } from "./sub-agent.ts";
export { createSymbolsToolRenderer } from "./symbols.ts";
export type { BuiltinToolRenderer } from "./types.ts";
export { createWorkflowToolRenderer } from "./workflow.ts";
export { createWriteToolRenderer } from "./write.ts";

import { createBashToolRenderer } from "./bash.ts";
import { createEditToolRenderer } from "./edit.ts";
import { createFindToolRenderer } from "./find.ts";
import { createGrepToolRenderer } from "./grep.ts";
import { createLsToolRenderer } from "./ls.ts";
import { createPwshToolRenderer } from "./pwsh.ts";
import { createReadToolRenderer } from "./read.ts";
import { createSubAgentToolRenderer } from "./sub-agent.ts";
import { createSymbolsToolRenderer } from "./symbols.ts";
import type { BuiltinToolRenderer } from "./types.ts";
import { createWorkflowToolRenderer } from "./workflow.ts";
import { createWriteToolRenderer } from "./write.ts";

const builtinRenderers: Record<string, BuiltinToolRenderer | undefined> = {
	bash: createBashToolRenderer(),
	pwsh: createPwshToolRenderer(),
	read: createReadToolRenderer(),
	write: createWriteToolRenderer(),
	grep: createGrepToolRenderer(),
	find: createFindToolRenderer(),
	ls: createLsToolRenderer(),
	edit: createEditToolRenderer(),
	symbols: createSymbolsToolRenderer(),
	agent: createSubAgentToolRenderer(),
	workflow: createWorkflowToolRenderer("Workflow"),
	ultracode: createWorkflowToolRenderer("Ultracode"),
};

export function getBuiltinToolRenderer(toolName: string): BuiltinToolRenderer | undefined {
	return builtinRenderers[toolName.toLowerCase()];
}
