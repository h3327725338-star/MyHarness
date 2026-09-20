/**
 * Code Intelligence 统一数据模型出口。
 * 未来 Lightweight Backend / Semantic LSP Backend / Symbol Store 都通过这里交换数据。
 */

export * from "./index/lightweight/index.ts";
export * from "./index/router/index.ts";
export * from "./legacy-adapter.ts";
// LSP 基础设施（板块 3）：协议通信层，与 Code Intelligence 领域模型保持概念分离。
export * from "./lsp/index.ts";
export * from "./lsp/language-server/index.ts";
export {
	getDocumentIdentity,
	getWorkspaceRelativeIdentity,
	isInsideWorkspace,
	normalizeDocumentPath,
	normalizeWorkspaceRelativePath,
	relativeToWorkspace,
	samePath,
} from "./path-semantics.ts";
export * from "./runtime/index.ts";
export * from "./semantic/index.ts";
export * from "./store/index.ts";
export * from "./symbol-identity.ts";
export * from "./types.ts";
