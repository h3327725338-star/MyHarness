/**
 * LSP file:// URI 工具。
 *
 * URI conversion is implemented by the shared Windows Code Intelligence path
 * contract so LanguageServerManager, Semantic Backend, and converters cannot
 * drift into separate path rules.
 */

export { fromFileUri, toFileUri } from "../path-semantics.ts";
