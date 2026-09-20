import { Type } from "typebox";
import { AccountConnections } from "../../providers/credentials/account-connections.ts";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import { truncateHead } from "../truncate.ts";

const schema = Type.Object({
	path: Type.String({
		description:
			"GitHub REST API path including query parameters, e.g. /user/repos?visibility=private&per_page=100 or /user/emails. Use /graphql with POST and a query body for GraphQL.",
	}),
	method: Type.Optional(
		Type.Union(
			[
				Type.Literal("GET"),
				Type.Literal("POST"),
				Type.Literal("PUT"),
				Type.Literal("PATCH"),
				Type.Literal("DELETE"),
			],
			{
				description:
					"HTTP method; defaults to GET. Mutating requests require user authorization for that operation.",
			},
		),
	),
	body: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "JSON request body for write requests or GraphQL." }),
	),
});

export interface GitHubToolOptions {
	connections?: AccountConnections;
}

export function createGitHubToolDefinition(
	_cwd: string,
	options?: GitHubToolOptions,
): BusinessToolDefinition<typeof schema> {
	const connections = options?.connections ?? new AccountConnections();
	return {
		name: "github",
		label: "GitHub",
		description:
			"Access the user's connected GitHub account via authenticated REST or GraphQL JSON APIs. Supports public/private repositories, files, issues, PRs, account email addresses, organizations, workflows and other resources permitted by the user's grant. No token arguments needed; sign in via /settings → GitHub Connect. GET is the default. Only perform writes, mutations or deletions explicitly authorized by the user; connecting an account alone is not authorization to modify it. Results contain one page; follow next for pagination. A 403/404 can mean missing scopes or organization SSO approval. Email addresses are not an email inbox. Output is capped at 50KB/2000 lines; use pagination and narrower queries if truncated.",
		promptSnippet: loadSystemPrompt("tools/github/snippet.md"),
		parameters: schema,
		async execute(_id, { path, method = "GET", body }, signal) {
			const result = await connections.api(path, method, body, signal ?? new AbortController().signal);
			const output = truncateHead(JSON.stringify(result, null, 2));
			return {
				content: [
					{
						type: "text",
						text:
							output.content +
							(output.truncated ? "\n[Output truncated; use pagination or a narrower query.]" : ""),
					},
				],
				details: {},
			};
		},
	};
}

export function createGitHubTool(cwd: string, options?: GitHubToolOptions) {
	return wrapToolDefinition(createGitHubToolDefinition(cwd, options));
}
