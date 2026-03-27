import { z } from "zod/v4";
import type { SkillDefinition, ToolDefinition } from "@maximus/shared";

/**
 * Replace {{variable}} placeholders in a template string with values from vars.
 * Throws if a referenced variable is not found in vars.
 */
export function interpolateTemplate(
	template: string,
	vars: Record<string, string>,
): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
		if (!(key in vars)) {
			throw new Error(
				`Template variable '${key}' not found in provided variables`,
			);
		}
		return vars[key];
	});
}

/**
 * Filter an object to only include keys in the allowlist.
 * Returns the full object if no allowlist is provided or it's empty.
 */
export function filterOutputFields(
	data: Record<string, unknown>,
	includeList?: string[],
): Record<string, unknown> {
	if (!includeList || includeList.length === 0) return data;
	const filtered: Record<string, unknown> = {};
	for (const key of includeList) {
		if (key in data) filtered[key] = data[key];
	}
	return filtered;
}

/**
 * Interpolate all string values in an object using template variables.
 */
function interpolateObject(
	obj: Record<string, any>,
	vars: Record<string, string>,
): Record<string, any> {
	const result: Record<string, any> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === "string") {
			result[key] = interpolateTemplate(value, vars);
		} else {
			result[key] = value;
		}
	}
	return result;
}

/**
 * Convert a YAML parameter type string to a Zod schema.
 * Exported for testing.
 */
export function yamlParamToZod(paramDef: {
	type: string;
	description: string;
}): z.ZodType {
	switch (paramDef.type) {
		case "string":
			return z.string().describe(paramDef.description);
		case "number":
			return z.number().describe(paramDef.description);
		case "boolean":
			return z.boolean().describe(paramDef.description);
		default:
			return z.string().describe(paramDef.description);
	}
}

/**
 * Build a raw Zod shape (Record of Zod types) from a tool's parameter definitions.
 * This is the format the SDK's tool() function expects.
 * Exported for testing.
 */
export function buildToolParamsShape(
	toolDef: ToolDefinition,
): Record<string, z.ZodType> {
	const shape: Record<string, z.ZodType> = {};
	for (const [name, param] of Object.entries(toolDef.parameters)) {
		shape[name] = yamlParamToZod(param);
	}
	return shape;
}

/**
 * Build a Zod object schema from a tool's parameter definitions.
 * Wraps buildToolParamsShape in z.object() for standalone validation use.
 * Exported for testing.
 */
export function buildToolParamsSchema(
	toolDef: ToolDefinition,
): z.ZodObject<any> {
	return z.object(buildToolParamsShape(toolDef));
}

export interface CredentialResolver {
	resolve(name: string): Promise<string>;
}

/**
 * Compose a SkillDefinition into an MCP server configuration.
 * Uses the Claude Agent SDK's createSdkMcpServer and tool helpers.
 *
 * Note: Full SDK integration tested in Plan 04. This function
 * may throw at import time if SDK is not fully available.
 */
export async function composeSkillToMcpServer(
	skill: SkillDefinition,
	credentialResolver: CredentialResolver,
) {
	// Dynamic import to avoid breaking tests when SDK isn't available
	const { createSdkMcpServer, tool } = await import(
		"@anthropic-ai/claude-agent-sdk"
	);

	return createSdkMcpServer({
		name: skill.name,
		version: skill.version ?? "1.0.0",
		tools: skill.tools.map((t) =>
			tool(
				t.name,
				t.description,
				buildToolParamsShape(t),
				async (args: Record<string, unknown>) => {
					// Resolve credentials from vault -- agent never sees these
					const resolvedCreds: Record<string, string> = {};
					for (const credRef of t.credentials ?? []) {
						resolvedCreds[credRef.inject_as] =
							await credentialResolver.resolve(credRef.ref);
					}
					// If no action defined or builtin type, return stub
					if (!t.action || t.action.type === "builtin") {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										status: "tool_executed",
										tool: t.name,
										args,
									}),
								},
							],
						};
					}

					// Merge args + resolved credentials for template interpolation
					const allVars: Record<string, string> = {};
					for (const [k, v] of Object.entries(args)) {
						allVars[k] = String(v);
					}
					for (const [k, v] of Object.entries(resolvedCreds)) {
						allVars[k] = v;
					}

					try {
						const interpolatedUrl = interpolateTemplate(
							t.action.url,
							allVars,
						);
						const interpolatedHeaders = t.action.headers
							? interpolateObject(t.action.headers, allVars)
							: undefined;
						let bodyStr: string | undefined;
						if (typeof t.action.body === "string") {
							bodyStr = interpolateTemplate(t.action.body, allVars);
						} else if (t.action.body) {
							bodyStr = JSON.stringify(interpolateObject(t.action.body, allVars));
						}

						const response = await fetch(interpolatedUrl, {
							method: t.action.method,
							headers: interpolatedHeaders,
							body: bodyStr,
						});

						if (!response.ok) {
							return {
								content: [
									{
										type: "text" as const,
										text: JSON.stringify({
											error: `HTTP ${response.status}: ${response.statusText}`,
										}),
									},
								],
								isError: true,
							};
						}

						const responseData = await response.json();
						const filtered = filterOutputFields(
							responseData,
							t.output?.include,
						);

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(filtered),
								},
							],
						};
					} catch (error) {
						const message =
							error instanceof Error
								? error.message
								: String(error);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										error: `Tool execution failed: ${message}`,
									}),
								},
							],
							isError: true,
						};
					}
				},
			),
		),
	});
}
