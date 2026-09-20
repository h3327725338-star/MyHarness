/**
 * Deprecated automatic-commit example.
 *
 * Automatic commits on shutdown are intentionally disabled. Use the built-in
 * /commit command so the shared Git workflow can validate, diagnose, repair,
 * and report the local commit safely.
 */
import type { ExtensionAPI } from "@myharness/coding-agent";

/**
 * Keep this module as a compatibility-safe no-op for users who still have the
 * old example path copied into an extension package.
 */
export default function (_pi: ExtensionAPI): void {}
