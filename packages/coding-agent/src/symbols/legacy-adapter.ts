/**
 * Legacy Adapter：把当前 CodeSymbolIndex 输出的旧索引格式（IndexedCodeSymbol）
 * 转换为统一 Code Intelligence 模型（CodeSymbol）。
 *
 * 证据原则：
 * - 只转换旧数据中真实存在的字段（path/language/kind/name/parentName/line/endLine/
 *   signature/exported）。
 * - 旧数据不知道的信息（精确 column、真实 overload、semantic parent、visibility）
 *   一律保持 undefined，禁止伪造。
 * - 不做任何源码扫描 / parser 修复：旧 parser 漏掉的符号（如 Java 带返回类型的
 *   方法）不在转换职责范围内。
 */

import type { IndexedCodeReference, IndexedCodeSymbol } from "./index/code-index.ts";
import { buildNamePath, createSymbolId, normalizeSymbolPath } from "./symbol-identity.ts";
import type { CodeReference, CodeSymbol } from "./types.ts";

export interface LegacyConversionOptions {
	/**
	 * 旧数据的行号基数。legacy lightweight parser 输出 1-based 行号，
	 * 转换为统一模型（0-based）时减 1。默认 1。
	 */
	legacyLineBase?: number;
}

const DEFAULT_LEGACY_LINE_BASE = 1;

/**
 * 单个旧符号 → 统一模型。
 *
 * namePath 规则：旧数据有 parentName 时构造 "parentName/name"（两级）；
 * 旧数据没有 parent 时 namePath = name。不做多级推断（旧 parser 的 parent
 * 是"行区间内最近的容器"，仅一层；不扫描源码补充更多层级）。
 */
export function convertLegacySymbol(symbol: IndexedCodeSymbol, options: LegacyConversionOptions = {}): CodeSymbol {
	const lineBase = options.legacyLineBase ?? DEFAULT_LEGACY_LINE_BASE;
	const path = normalizeSymbolPath(symbol.path);
	const namePath = symbol.parentName ? buildNamePath([symbol.parentName, symbol.name]) : symbol.name;
	return {
		id: createSymbolId({ path, kind: symbol.kind, namePath, line: symbol.line - lineBase }),
		name: symbol.name,
		namePath,
		kind: symbol.kind,
		language: symbol.language,
		path,
		// 行级精度：旧 parser 无法确定 identifier 精确 column，
		// 因此 selectionRange / bodyRange 保持 undefined，不伪造。
		line: symbol.line - lineBase,
		bodyEndLine: symbol.endLine - lineBase,
		parentNamePath: symbol.parentName ?? undefined,
		// 旧数据没有可靠信息，以下字段保持缺省（不猜测）：
		//   overloadIndex（旧数据无法确认 overload）
		//   parentId（旧数据没有父符号 id 概念）
		//   visibility（旧数据没有可见性字段）
		signature: symbol.signature,
		exported: symbol.exported,
	};
}

/** 批量转换。 */
export function convertLegacySymbols(
	symbols: readonly IndexedCodeSymbol[],
	options?: LegacyConversionOptions,
): CodeSymbol[] {
	return symbols.map((symbol) => convertLegacySymbol(symbol, options));
}

/**
 * Convert a legacy lexical reference without inventing a column or target identity.
 * The index stores 1-based lines; the unified domain stores 0-based line precision.
 */
export function convertLegacyReference(
	reference: IndexedCodeReference,
	options: LegacyConversionOptions = {},
): CodeReference {
	const lineBase = options.legacyLineBase ?? DEFAULT_LEGACY_LINE_BASE;
	return {
		location: {
			path: normalizeSymbolPath(reference.path),
			line: reference.line - lineBase,
		},
		kind: reference.referenceKind,
	};
}

export function convertLegacyReferences(
	references: readonly IndexedCodeReference[],
	options?: LegacyConversionOptions,
): CodeReference[] {
	return references.map((reference) => convertLegacyReference(reference, options));
}
