/**
 * Application-facing Workspace exports.
 *
 * The persistence implementation lives in the Data layer so Session storage
 * can resolve the same Workspace identity without depending on UI/application
 * code.
 */
export * from "../data/workspace-store.ts";
