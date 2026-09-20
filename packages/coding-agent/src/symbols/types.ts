/**
 * Code Intelligence 统一数据模型。
 *
 * 这是 Lightweight Backend / Semantic LSP Backend / Symbol Store 共用的领域模型。
 * 任何 backend 的原始响应进入 Code Intelligence domain 之前都必须转换为这里的类型。
 *
 * 坐标与路径不变量（invariants）：
 * - 内部位置一律 0-based（line / character 从 0 开始），与未来 LSP 坐标一致；
 *   需要 1-based 展示（例如 symbols tool 的 "path:line" 输出）时由展示层转换。
 * - CodeRange.end 为 exclusive（区间为 [start, end)），与 LSP 一致。
 * - CodeSymbol.path / CodeLocation.path 一律为项目根目录相对路径，POSIX 风格 "/"。
 *
 * 精度不变量（invariants）：
 * - 不知道精确 selection/body range 时，selectionRange/bodyRange 为 undefined，禁止伪造。
 * - 不知道 overload 时 overloadIndex 为 undefined，禁止按出现顺序猜测。
 * - 不知道 visibility 时 visibility 为 undefined，禁止猜测。
 *
 * 身份不变量（invariants）：
 * - namePath 是人类可读、可搜索、可消歧的 locator，不是全局唯一 ID。
 * - SymbolId 是当前项目快照内的稳定 locator，不承诺跨任意代码修改（rename/move/git
 *   checkout）永久稳定。
 *
 * 结果语义不变量（invariants）：
 * - items: [] 只表示"查询成功且确实没有结果"；失败/降级必须通过 meta 表达。
 * - "lightweight" 不等于 "partial"（search_code 天然 lightweight 但可以 complete）。
 * - "fallback" 不等于 "lightweight"（search_code 本来就是 lightweight，不是 fallback）。
 */

// =============================================================================
// 位置模型
// =============================================================================

export interface CodePosition {
	/** 0-based line */
	line: number;
	/** 0-based character（UTF-16 code unit 偏移，与 LSP 一致） */
	character: number;
}

export interface CodeRange {
	start: CodePosition;
	/** exclusive end：区间为 [start, end) */
	end: CodePosition;
}

export interface CodeLocation {
	/** 项目根目录相对路径（POSIX 风格） */
	path: string;
	/** 精确范围。行级精度的数据源（如 legacy lightweight parser）不提供时缺省。 */
	range?: CodeRange;
	/** 0-based 行级精度；仅当数据源知道行号但不知道精确 column 时使用。 */
	line?: number;
}

// =============================================================================
// Symbol 模型
// =============================================================================

/**
 * 符号种类。前 12 种与 legacy lightweight parser 输出完全兼容；
 * 其余为未来 LSP documentSymbol 常见且含义明确的种类。
 * 无法映射的 backend kind 一律归为 "unknown"，不允许 crash。
 */
export type CodeSymbolKind =
	| "class"
	| "function"
	| "method"
	| "interface"
	| "type"
	| "enum"
	| "namespace"
	| "module"
	| "struct"
	| "trait"
	| "variable"
	| "constant"
	| "constructor"
	| "property"
	| "field"
	| "enum_member"
	| "parameter"
	| "type_parameter"
	| "package"
	| "operator"
	| "unknown";

export type SymbolVisibility = "public" | "protected" | "private" | "internal" | "package" | "unknown";

/**
 * 符号 id：当前项目快照内的稳定 locator（由 path + kind + namePath + 行号确定性生成）。
 * 不承诺跨任意代码修改永久稳定。
 */
export type SymbolId = string;

export interface CodeSymbol {
	/** 当前项目快照内的稳定 locator，见 SymbolId 注释 */
	id: SymbolId;

	/** 符号名（不含父级） */
	name: string;
	/** 层级定位符（如 "Api/UserService/load"、"A/run[0]"）；不是全局唯一 ID */
	namePath: string;

	kind: CodeSymbolKind;
	language: string;

	/** 项目根目录相对路径（POSIX 风格） */
	path: string;

	/** 精确 selection range；未知时缺省（禁止伪造 column） */
	selectionRange?: CodeRange;
	/** 精确 body range（函数体/类体等）；未知时缺省 */
	bodyRange?: CodeRange;
	/**
	 * 0-based 声明行（行级精度）。
	 * 轻量 parser 只能确定声明行、无法确定精确 column 时使用；
	 * 此时 selectionRange 保持 undefined，两者同时存在只是精度不同，不是互相替代。
	 */
	line?: number;
	/** 0-based、inclusive body 结束行（行级精度；legacy endLine 转换而来） */
	bodyEndLine?: number;

	/** 父符号 id；未知时缺省 */
	parentId?: SymbolId;
	/** 父符号的 namePath（如 "Api/UserService"）；未知时缺省 */
	parentNamePath?: string;

	/** 0-based overload index；未知时缺省（禁止按出现顺序猜测） */
	overloadIndex?: number;

	/** 声明行签名文本（已脱敏）；未知时缺省 */
	signature?: string;

	/** 可见性；未知时缺省（禁止猜测） */
	visibility?: SymbolVisibility;
	/** 是否导出（export/pub 等）；未知时缺省 */
	exported?: boolean;
}

/** 树形展示用：file_symbols 等需要层级结构的场景。Symbol Store 本身存扁平记录。 */
export interface CodeSymbolTreeNode {
	symbol: CodeSymbol;
	children: CodeSymbolTreeNode[];
}

// =============================================================================
// 引用模型
// =============================================================================

/** 保守的引用角色：当前不承诺 read/write/call 等精确分类。 */
export type CodeReferenceKind = "definition" | "reference" | "unknown";

export interface CodeReference {
	/** 引用发生的位置 */
	location: CodeLocation;

	/** 被引用符号 id；lexical 数据源无法确定时缺省 */
	targetSymbolId?: SymbolId;
	/** 被引用符号 namePath；无法确定时缺省 */
	targetNamePath?: string;

	/** 引用角色；未知时缺省 */
	kind?: CodeReferenceKind;
}

// =============================================================================
// 查询 / 目标
// =============================================================================

/**
 * 用于 find_symbol 的搜索条件（模糊搜索），与 SymbolTarget 严格分离：
 * SymbolQuery 是"搜索符号"，SymbolTarget 是"指向某个具体符号/位置"。
 */
export interface SymbolQuery {
	/** 名称搜索串（substring / 前缀语义由 backend 决定） */
	query?: string;
	/** namePath 过滤（如 "UserService/load"） */
	namePath?: string;
	/** 项目相对路径过滤（文件或目录） */
	path?: string;
	/** kind 过滤 */
	kinds?: CodeSymbolKind[];
	/** 是否要求精确匹配（默认模糊） */
	exact?: boolean;
	/** 结果数量上限 */
	limit?: number;
}

/**
 * 用于 find_definition / find_references / find_implementations 的符号目标。
 * 三种方式：已获得的符号 id / 代码中的精确位置 / namePath 消歧。
 */
export type SymbolTarget =
	| {
			type: "symbol_id";
			symbolId: SymbolId;
	  }
	| {
			type: "position";
			path: string;
			position: CodePosition;
	  }
	| {
			type: "name_path";
			/** 可选的项目相对路径过滤 */
			path?: string;
			namePath: string;
	  };

// =============================================================================
// 结果元数据
// =============================================================================

/** 查询来源：语义后端（LSP）或轻量后端（词法）。 */
export type IntelligenceSource = "semantic" | "lightweight";

/** 结果完整性：complete 表示该来源下结果完整，partial 表示受限制截断。 */
export type ResultCompleteness = "complete" | "partial";

export interface IntelligenceResultMeta {
	source: IntelligenceSource;
	completeness: ResultCompleteness;

	/** 仅当结果来自降级路径时存在（例如 semantic backend 不可用后使用 lexical） */
	fallback?: {
		reason: string;
		message?: string;
	};

	warnings?: string[];
}

/** 统一查询结果：items 为空只表示"查询成功且确实没有结果"。 */
export interface IntelligenceResult<T> {
	items: T[];
	meta: IntelligenceResultMeta;
}

// =============================================================================
// 诊断模型（未来 LSP diagnostics 的最小领域形态）
// =============================================================================

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint" | "unknown";

export interface CodeDiagnostic {
	location: CodeLocation;
	severity?: DiagnosticSeverity;
	message: string;
	source?: string;
	code?: string;
}

// =============================================================================
// Advanced semantic models
// =============================================================================

/** A hover fragment normalized from LSP MarkedString / MarkupContent. */
export type CodeHoverContent =
	| { readonly kind: "plaintext"; readonly value: string }
	| { readonly kind: "markdown"; readonly value: string }
	| { readonly kind: "code"; readonly value: string; readonly language?: string };

export interface CodeHoverInfo {
	/** The range the server associated with the hover, when it supplied a valid range. */
	readonly location?: CodeLocation;
	readonly contents: readonly CodeHoverContent[];
}

/** One incoming or outgoing call edge and the real call sites reported by LSP. */
export interface CodeCallEdge {
	readonly symbol: CodeSymbol;
	readonly callSites: readonly CodeLocation[];
}

// =============================================================================
// 语义化结果别名
// =============================================================================

export type SymbolSearchResult = IntelligenceResult<CodeSymbol>;
export type DefinitionResult = IntelligenceResult<CodeSymbol>;
export type ReferencesResult = IntelligenceResult<CodeReference>;
export type ImplementationsResult = IntelligenceResult<CodeSymbol>;
export type FileSymbolsResult = IntelligenceResult<CodeSymbolTreeNode>;
export type DiagnosticsResult = IntelligenceResult<CodeDiagnostic>;
export type WorkspaceSymbolsResult = IntelligenceResult<CodeSymbol>;
export type HoverResult = IntelligenceResult<CodeHoverInfo>;
export type CallHierarchyResult = IntelligenceResult<CodeCallEdge>;
export type TypeHierarchyResult = IntelligenceResult<CodeSymbol>;
export type ResolvedSymbolResult = IntelligenceResult<CodeSymbol>;
