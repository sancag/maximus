export function sanitizeString(text: string): string {
	return (
		text
			// Anthropic API keys (sk-ant-...)
			.replace(/sk-ant-[a-zA-Z0-9-]{20,}/g, "[REDACTED_ANTHROPIC_KEY]")
			// OpenAI API keys
			.replace(/sk-[a-zA-Z0-9]{20,}/g, "[REDACTED_API_KEY]")
			// GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
			.replace(/gh[pousr]_[a-zA-Z0-9]{36,}/g, "[REDACTED_GH_TOKEN]")
			// AWS access keys
			.replace(/AKIA[A-Z0-9]{16}/g, "[REDACTED_AWS_KEY]")
			// Generic Bearer/token/key patterns
			.replace(
				/(?:Bearer|token|api[_-]?key)\s*[:=]\s*\S{10,}/gi,
				"[REDACTED]",
			)
			// Connection strings (postgres, mysql, mongodb, redis, amqp)
			.replace(
				/(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\s"']+/gi,
				"[REDACTED_CONN_STRING]",
			)
			// Authorization headers in error dumps
			.replace(/Authorization:\s*\S+/gi, "Authorization: [REDACTED]")
			// Generic long hex strings (40+ chars, likely tokens/hashes)
			.replace(
				/(?<![a-zA-Z0-9/+])[a-f0-9]{40,}(?![a-zA-Z0-9/+=])/gi,
				"[REDACTED_HASH]",
			)
	);
}

export interface McpToolResult {
	content: Array<{ type: string; text?: string; [key: string]: unknown }>;
	isError?: boolean;
}

export function sanitizeToolResult(result: McpToolResult): McpToolResult {
	return {
		...result,
		content: result.content.map((item) => {
			if (item.type === "text" && typeof item.text === "string") {
				return { ...item, text: sanitizeString(item.text) };
			}
			return item;
		}),
	};
}

// Returns a hook function compatible with SDK PostToolUse hooks
export function createSanitizerHook() {
	return async (input: { tool_response?: string | McpToolResult }) => {
		const response = input.tool_response;
		if (typeof response === "string") {
			const sanitized = sanitizeString(response);
			if (sanitized !== response) {
				return {
					hookSpecificOutput: {
						hookEventName: "PostToolUse" as const,
						updatedMCPToolOutput: sanitized,
					},
				};
			}
		}
		return {} as Record<string, never>;
	};
}
