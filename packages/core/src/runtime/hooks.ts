import { createSanitizerHook } from "@maximus/vault";
import { EventBus } from "../events/bus.js";
import { nanoid } from "nanoid";

/** Paths agents must never read or access */
const BLOCKED_PATHS = [
	".env",
	"vault/store.json",
	"vault/store",
];

/** Patterns that indicate vault-cracking attempts in shell commands */
const BLOCKED_COMMAND_PATTERNS = [
	/vault\/store/i,
	/\.env\b/,
	/MAXIMUS_VAULT_KEY/,
	/VAULT_KEY/,
	/scryptSync|createDecipheriv|crypto\..*decrypt/i,
];

function isBlockedPath(filePath: string): boolean {
	return BLOCKED_PATHS.some(
		(blocked) => filePath.endsWith(blocked) || filePath.includes(`/${blocked}`),
	);
}

function isBlockedCommand(command: string): boolean {
	return BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * PreToolUse hook that blocks agents from accessing vault secrets,
 * .env files, or running commands that attempt to decrypt the vault.
 */
async function vaultGuardHook(input: any, _toolUseID?: string, _options?: any) {
	if (input.hook_event_name !== "PreToolUse") return { continue: true };

	const toolName = input.tool_name;
	const toolInput = input.tool_input as Record<string, unknown> | undefined;

	// Block Read/Glob of sensitive files
	if (toolName === "Read" || toolName === "Glob") {
		const filePath = (toolInput?.file_path as string) ?? (toolInput?.pattern as string) ?? "";
		if (isBlockedPath(filePath)) {
			return {
				decision: "block" as const,
				reason: "Access denied: vault secrets and .env files are not accessible to agents. Use your skill tools to interact with APIs — credentials are injected automatically.",
			};
		}
	}

	// Block Bash commands that target vault or .env
	if (toolName === "Bash") {
		const command = (toolInput?.command as string) ?? "";
		if (isBlockedCommand(command)) {
			return {
				decision: "block" as const,
				reason: "Access denied: commands accessing vault secrets or .env files are blocked. Use your skill tools to interact with APIs — credentials are injected automatically.",
			};
		}
	}

	return { continue: true };
}

/**
 * Truncate a string to maxChars, appending '...[truncated]' if exceeded.
 */
function truncateResult(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return value.slice(0, maxChars) + "...[truncated]";
}

export function createHooks(
	eventBus: EventBus,
	agentName: string,
	sessionId: string,
	traceId?: string,
	maxToolResultChars: number = 2000,
) {
	const sanitizerHook = createSanitizerHook();

	// Wrap sanitizer to match SDK HookCallback signature:
	// (input: HookInput, toolUseID: string | undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput>
	const wrappedSanitizer = async (input: any, _toolUseID?: string, _options?: any) => {
		return sanitizerHook(input);
	};

	/**
	 * PostToolUse hook that emits agent:tool_result events for successful tool calls.
	 */
	async function toolResultHook(input: any, _toolUseID?: string, _options?: any) {
		if (input.hook_event_name !== "PostToolUse") return { continue: true };

		const toolResponse = input.tool_response;
		const responseStr = typeof toolResponse === "string"
			? toolResponse
			: JSON.stringify(toolResponse);
		const truncatedResponse = truncateResult(responseStr, maxToolResultChars);

		eventBus.emit({
			id: nanoid(),
			timestamp: Date.now(),
			sessionId,
			agentName,
			type: "agent:tool_result",
			payload: {
				tool: input.tool_name,
				input: input.tool_input,
				result: truncatedResponse,
				success: true,
				toolUseId: input.tool_use_id,
			},
			traceId,
		});

		return { continue: true };
	}

	/**
	 * PostToolUseFailure hook that emits agent:tool_result events for failed tool calls.
	 */
	async function toolFailureHook(input: any, _toolUseID?: string, _options?: any) {
		if (input.hook_event_name !== "PostToolUseFailure") return { continue: true };

		eventBus.emit({
			id: nanoid(),
			timestamp: Date.now(),
			sessionId,
			agentName,
			type: "agent:tool_result",
			payload: {
				tool: input.tool_name,
				input: input.tool_input,
				error: input.error,
				success: false,
				toolUseId: input.tool_use_id,
			},
			traceId,
		});

		return { continue: true };
	}

	return {
		PreToolUse: [
			{
				hooks: [vaultGuardHook],
			},
		],
		PostToolUse: [
			{
				hooks: [toolResultHook, wrappedSanitizer],
			},
		],
		PostToolUseFailure: [
			{
				hooks: [toolFailureHook],
			},
		],
	};
}

// Filter environment variables to prevent vault key leakage to SDK subprocess
// Per CONTEXT.md: "The vault key lives in the tool executor process, never in the agent process"
export function filterEnvForSdk(
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	const BLOCKED_VARS = [
		"MAXIMUS_VAULT_KEY",
		"VAULT_KEY",
		"ENCRYPTION_KEY",
		"MASTER_KEY",
	];

	const filtered: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !BLOCKED_VARS.includes(key)) {
			filtered[key] = value;
		}
	}
	return filtered;
}
