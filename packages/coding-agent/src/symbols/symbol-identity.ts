/**
 * Symbol identity 工具：namePath 构造/解析、SymbolId 生成、路径规范化。
 * 全部为纯内存轻量操作，不依赖任何 I/O。
 *
 * namePath 规则：
 * - 内部以 string[] components 为构造基础；字符串 namePath 只是序列化形式，
 *   不要直接 namePath.split("/") 并假设安全。
 * - 分隔符为 "/"，组件内的 "/" 与 "\" 使用 "\" 转义（"/" → "\/"、"\" → "\\"）。
 * - overload 以 "[n]" 后缀挂在最后一段（0-based）。
 *
 * SymbolId 规则：
 * - 由 path + kind + namePath + 0-based 声明行确定性生成。
 * - 是当前项目快照内的稳定 locator；不承诺跨任意代码修改永久稳定。
 */

import { getDocumentIdentity, normalizeWorkspaceRelativePath } from "./path-semantics.ts";
import type { CodeSymbolKind, SymbolId } from "./types.ts";

export const NAMEPATH_SEPARATOR = "/" as const;

export interface ParsedNamePath {
	/** 层级组件（已反转义；不含 overload 后缀） */
	components: string[];
	/** 0-based overload index；不存在时为 undefined */
	overloadIndex?: number;
}

function escapeComponent(component: string): string {
	return component.replace(/\\/g, "\\\\").replace(/\//g, "\\/");
}

/**
 * 由组件数组构造 namePath（组件按层级从根到叶）。
 * undefined / 空字符串组件会被忽略（例如 legacy 数据没有 parent 时）。
 * overloadIndex（0-based）可选，只挂在最后一段。
 *
 * 例：buildNamePath(["UserService", "load"]) === "UserService/load"
 *     buildNamePath(["UserService", "load"], 0) === "UserService/load[0]"
 *     buildNamePath([undefined, "load"]) === "load"
 */
export function buildNamePath(components: ReadonlyArray<string | undefined>, overloadIndex?: number): string {
	const parts = components
		.filter((component): component is string => component !== undefined && component !== "")
		.map(escapeComponent);
	const base = parts.join(NAMEPATH_SEPARATOR);
	if (overloadIndex === undefined) return base;
	return `${base}[${overloadIndex}]`;
}

/**
 * 解析 namePath 为组件数组与可选 overload index。
 * 组件中的转义（"\/"、"\\"）会被还原。
 *
 * 例：parseNamePath("Api/UserService/load") === { components: ["Api", "UserService", "load"] }
 *     parseNamePath("UserService/load[0]") === { components: ["UserService", "load"], overloadIndex: 0 }
 */
export function parseNamePath(namePath: string): ParsedNamePath {
	let body = namePath;
	let overloadIndex: number | undefined;
	const overloadMatch = /\[(\d+)\]$/.exec(body);
	if (overloadMatch) {
		overloadIndex = Number(overloadMatch[1]);
		body = body.slice(0, -overloadMatch[0].length);
	}
	const components: string[] = [];
	let current = "";
	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (char === "\\") {
			const next = body[index + 1];
			if (next !== undefined) {
				current += next;
				index++;
			} else {
				current += char;
			}
			continue;
		}
		if (char === NAMEPATH_SEPARATOR) {
			components.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	components.push(current);
	return { components, overloadIndex };
}

/**
 * 返回 namePath 的父级 namePath；没有父级（单组件）时返回 undefined。
 * overload 后缀属于叶符号，不会出现在父级 namePath 中。
 *
 * 例：getParentNamePath("Api/UserService/load") === "Api/UserService"
 *     getParentNamePath("UserService/load[0]") === "UserService"
 *     getParentNamePath("load") === undefined
 */
export function getParentNamePath(namePath: string): string | undefined {
	const { components } = parseNamePath(namePath);
	if (components.length <= 1) return undefined;
	return buildNamePath(components.slice(0, -1));
}

/**
 * 规范化项目相对路径：统一 POSIX 分隔符、去掉 "./" 前缀与前导 "/"。
 * 保持相对路径语义（不以 "/" 开头）。
 */
export function normalizeSymbolPath(path: string): string {
	return normalizeWorkspaceRelativePath(path);
}

export interface SymbolIdInput {
	/** 项目相对路径（POSIX；会自动规范化） */
	path: string;
	kind: CodeSymbolKind;
	/** namePath（如 "Api/UserService/load"） */
	namePath: string;
	/** 0-based 声明行（行级精度即可；未来 LSP 同样以 selection start 行参与） */
	line: number;
	/**
	 * Optional 0-based UTF-16 selection character. Semantic providers use this
	 * when two real symbols share a declaration line; legacy ids intentionally
	 * omit it to preserve the Phase 7 compatibility format.
	 */
	character?: number;
}

/**
 * 确定性生成 SymbolId：path + kind + namePath + 0-based 行。
 *
 * 稳定性边界：
 * - 同一项目快照内，不同文件、不同父级、不同 overload、不同行的同名符号必然得到不同 id。
 * - 不承诺跨任意代码修改（rename/move/git checkout）永久稳定。
 * - 极端情况下同一行声明两个同名同类符号（如同一行两个 overload）可能碰撞；
 *   现实代码中不存在，未来需要时可通过 selection character 扩展。
 */
export function createSymbolId(input: SymbolIdInput): SymbolId {
	const base = `${getDocumentIdentity(normalizeSymbolPath(input.path))}:${input.kind}:${input.namePath}:${input.line}`;
	return input.character === undefined ? base : `${base}:${input.character}`;
}
