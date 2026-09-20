/**
 * LSP 基础设施基础类型（板块 3）。
 *
 * 职责边界：
 * - 这里只定义 JSON-RPC 2.0 与 LSP over stdio 通信所需的最小类型 subset。
 * - 不与 Code Intelligence 领域模型（CodePosition / CodeRange / CodeLocation /
 *   CodeSymbol 等）混用：LSP Position/Range/Location 是协议结构，即使字段相似
 *   也保持概念边界，未来由 Semantic Backend adapter 负责转换。
 * - 不复制完整 LSP 规范类型；只定义本阶段真正需要的最小字段。
 */

// =============================================================================
// JSON value（协议层的宽松结构）
// =============================================================================

export type JsonPrimitive = string | number | boolean | null;

export type JsonObject = {
	[key: string]: JsonValue | undefined;
};

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** JSON-RPC request/response identifier. Null is only used for invalid-request responses. */
export type JsonRpcId = number | string;

// =============================================================================
// JSON-RPC 2.0 消息
// =============================================================================

export interface JsonRpcRequestMessage {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: JsonValue;
}

export interface JsonRpcNotificationMessage {
	jsonrpc: "2.0";
	method: string;
	params?: JsonValue;
}

/** 宽松的 error 结构（type alias：带隐式 index signature，可直接作 JsonValue 使用）。 */
export type JsonRpcErrorObject = {
	code: number;
	message: string;
	data?: JsonValue;
};

/** 宽松的 response 结构：result 与 error 二选一，由接收方校验。 */
export interface JsonRpcResponseMessage {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	result?: JsonValue;
	error?: JsonRpcErrorObject;
}

// =============================================================================
// LSP 最小类型 subset（与 Code Intelligence 领域模型严格分离）
// =============================================================================

/** LSP Position：0-based，character 为 UTF-16 code unit 偏移（协议默认编码）。 */
export interface LspPosition {
	line: number;
	character: number;
}

/** LSP Range：end 为 exclusive。 */
export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspLocation {
	uri: string;
	range: LspRange;
}

export type LspClientInfo = {
	name: string;
	version?: string;
};

export type LspWorkspaceFolder = {
	uri: string;
	name: string;
};

/**
 * Client capabilities：宽松结构，但本阶段只声明 MyHarness 真实支持的能力（默认空对象）。
 * 禁止谎报 capability（如 completion / semantic tokens / workspace edit）来换取
 * server 返回更多功能。
 */
export type LspClientCapabilities = JsonObject;

/** Server capabilities：宽松 subset，本阶段只保存，不做语义理解。 */
export type LspServerCapabilities = JsonObject;

export type LspServerInfo = {
	name: string;
	version?: string;
};

/**
 * LSP initialize 参数最小 subset（type alias：带隐式 index signature，
 * 可直接作为 JSON-RPC params 序列化）。
 */
export type LspInitializeParams = {
	processId: number | null;
	rootUri?: string | null;
	clientInfo?: LspClientInfo;
	capabilities: LspClientCapabilities;
	workspaceFolders?: LspWorkspaceFolder[] | null;
};

export interface LspInitializeResult {
	capabilities: LspServerCapabilities;
	serverInfo?: LspServerInfo;
}

// =============================================================================
// 配置与日志
// =============================================================================

export type LspLogLevel = "debug" | "info" | "warn" | "error";

export type LspLogCategory = "send" | "receive" | "stderr" | "process" | "lifecycle" | "protocol";

export interface LspLogEntry {
	level: LspLogLevel;
	category: LspLogCategory;
	message: string;
}

/** 日志回调：默认关闭（不打印每个 JSON-RPC 消息），需要时由调用方提供。 */
export type LspLogger = (entry: LspLogEntry) => void;

export interface LspProcessOptions {
	/** 可执行文件路径或命令名（不经过 shell） */
	command: string;
	args?: readonly string[];
	cwd?: string;
	/** 缺省时继承父进程环境 */
	env?: NodeJS.ProcessEnv;
	/** stderr 环形缓冲上限（bytes），防止无限缓存 */
	maxStderrBytes?: number;
	logger?: LspLogger;
}

export interface LspClientOptions {
	/** 每个 request 的默认超时（可 per-request 覆盖） */
	defaultRequestTimeoutMs?: number;
	/** shutdown request 的超时 */
	shutdownTimeoutMs?: number;
	/** 发送 exit notification 后等待进程退出的时间，超时强制 kill */
	processExitTimeoutMs?: number;
	/** 单个 LSP 消息 body 上限（bytes） */
	maxMessageBytes?: number;
	/** header 区上限（bytes），防止无终止符的无限缓冲 */
	maxHeaderBytes?: number;
	logger?: LspLogger;
}

export interface LspRequestOptions {
	signal?: AbortSignal;
	/** 覆盖默认 request 超时 */
	timeoutMs?: number;
}

// =============================================================================
// 状态机
// =============================================================================

/**
 * LspProcess 状态：
 * - created：未启动
 * - starting：spawn 进行中
 * - running：进程存活
 * - exited：进程已退出（正常或异常）
 * - failed：spawn 失败（command 不存在等）
 * - disposed：已清理，不可再使用
 */
export type LspProcessState = "created" | "starting" | "running" | "exited" | "failed" | "disposed";

/**
 * LspClient 状态：
 * - created：未启动
 * - starting：进程启动中
 * - started：进程已启动，可发送 request（未 initialize）
 * - initialized：initialize 已完成
 * - shutting_down：shutdown 流程进行中
 * - closed：已关闭，不可再使用
 * - failed：异常终止（spawn 失败 / initialize 失败 / 协议错误 / 意外退出）
 */
export type LspClientState = "created" | "starting" | "started" | "initialized" | "shutting_down" | "closed" | "failed";

// =============================================================================
// 默认值
// =============================================================================

/** 默认 request 超时：30 秒。语义查询可能较慢，但不能无限等待。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** shutdown request 超时：5 秒。 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/** exit notification 后等待进程退出的时间：5 秒，超时强制 kill。 */
export const DEFAULT_PROCESS_EXIT_TIMEOUT_MS = 5_000;

/**
 * 单个消息 body 上限：32 MiB。
 * 正常 LSP 消息（initialize result / diagnostics / symbols）远小于此；
 * 该上限只用于防止恶意或异常的 server 声明超大 Content-Length 导致无限内存分配。
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/** header 区上限：64 KiB。正常 header 只有几行（<1 KiB）。 */
export const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;

/** stderr 环形缓冲上限：64 KiB。 */
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
