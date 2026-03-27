import { describe, it, expect, vi } from "vitest";
import {
	sanitizeString,
	sanitizeToolResult,
	createSanitizerHook,
} from "../sanitizer.js";
import { retryWithPolicy } from "../retry.js";

describe("sanitizeString", () => {
	it("redacts GitHub tokens (ghp_)", () => {
		const input = "Bearer ghp_abcdef1234567890abcdef1234567890abcdef";
		const result = sanitizeString(input);
		expect(result).toContain("[REDACTED");
		expect(result).not.toContain("ghp_abcdef1234567890abcdef1234567890abcdef");
	});

	it("redacts GitHub tokens with other prefixes (gho_, ghu_, ghs_, ghr_)", () => {
		expect(sanitizeString("token gho_abcdef1234567890abcdef1234567890abcdef")).toContain("[REDACTED");
		expect(sanitizeString("token ghs_abcdef1234567890abcdef1234567890abcdef")).toContain("[REDACTED");
	});

	it("redacts Authorization headers", () => {
		const input = "Authorization: Bearer sk-abc123def456ghi789jkl012";
		const result = sanitizeString(input);
		expect(result).toContain("[REDACTED]");
		expect(result).not.toContain("sk-abc123");
	});

	it("redacts connection strings (postgres)", () => {
		const input = "postgres://user:pass@host:5432/db";
		const result = sanitizeString(input);
		expect(result).toContain("[REDACTED_CONN_STRING]");
		expect(result).not.toContain("postgres://user:pass");
	});

	it("redacts connection strings (mongodb, redis)", () => {
		expect(sanitizeString("mongodb://admin:pass@host/db")).toContain("[REDACTED_CONN_STRING]");
		expect(sanitizeString("redis://user:pass@host:6379")).toContain("[REDACTED_CONN_STRING]");
	});

	it("redacts generic api_key= patterns", () => {
		const input = "api_key=abcdef1234567890abcdef1234567890abcdef1234";
		const result = sanitizeString(input);
		expect(result).toContain("[REDACTED]");
		expect(result).not.toContain("abcdef1234567890abcdef1234567890abcdef1234");
	});

	it("leaves clean text unchanged", () => {
		const input = "Hello world, no secrets here";
		expect(sanitizeString(input)).toBe("Hello world, no secrets here");
	});

	it("redacts Anthropic API keys (sk-ant-api03-...)", () => {
		const input = "token: sk-ant-api03-abc123def456ghi789jkl012mno345pqr678";
		const result = sanitizeString(input);
		expect(result).toContain("[REDACTED");
		expect(result).not.toContain("sk-ant-api03");
	});

	it("redacts OpenAI API keys (sk-...)", () => {
		const input = "key=sk-proj1234567890abcdefghij";
		const result = sanitizeString(input);
		expect(result).toContain("[REDACTED");
		expect(result).not.toContain("sk-proj1234567890abcdefghij");
	});

	it("redacts AWS access keys", () => {
		const input = "aws_key=AKIAIOSFODNN7EXAMPLE";
		const result = sanitizeString(input);
		expect(result).toContain("[REDACTED");
		expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});
});

describe("sanitizeToolResult", () => {
	it("sanitizes text content items", () => {
		const result = sanitizeToolResult({
			content: [
				{
					type: "text",
					text: "token=secret12345678901234567890secret1234567890",
				},
			],
		});
		expect(result.content[0].text).not.toContain("secret123456789");
	});

	it("preserves non-text content items", () => {
		const result = sanitizeToolResult({
			content: [{ type: "image", data: "base64data" }],
		});
		expect(result.content[0]).toEqual({ type: "image", data: "base64data" });
	});

	it("preserves isError flag", () => {
		const result = sanitizeToolResult({
			content: [{ type: "text", text: "error occurred" }],
			isError: true,
		});
		expect(result.isError).toBe(true);
	});
});

describe("createSanitizerHook", () => {
	it("returns a function", () => {
		const hook = createSanitizerHook();
		expect(typeof hook).toBe("function");
	});

	it("sanitizes string tool responses", async () => {
		const hook = createSanitizerHook();
		const result = await hook({
			tool_response: "Authorization: Bearer sk-ant-api03-verylongkeyhere1234567890",
		});
		expect(result.hookSpecificOutput).toBeDefined();
		expect(result.hookSpecificOutput!.hookEventName).toBe("PostToolUse");
	});

	it("returns empty object for clean responses", async () => {
		const hook = createSanitizerHook();
		const result = await hook({ tool_response: "all good here" });
		expect(result).toEqual({});
	});
});

describe("retryWithPolicy", () => {
	it("succeeds immediately if fn succeeds on first call", async () => {
		const fn = vi.fn().mockResolvedValue("success");
		const result = await retryWithPolicy(fn, {
			maxRetries: 3,
			backoffMs: 1,
		});
		expect(result).toBe("success");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries on failure and succeeds on second call", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("fail"))
			.mockResolvedValue("success");
		const result = await retryWithPolicy(fn, {
			maxRetries: 3,
			backoffMs: 1,
		});
		expect(result).toBe("success");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("throws after exhausting retries", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("always fails"));
		await expect(
			retryWithPolicy(fn, { maxRetries: 2, backoffMs: 1 }),
		).rejects.toThrow("always fails");
		expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
	});

	it("respects shouldRetry predicate", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("fatal"));
		await expect(
			retryWithPolicy(fn, {
				maxRetries: 3,
				backoffMs: 1,
				shouldRetry: () => false,
			}),
		).rejects.toThrow("fatal");
		expect(fn).toHaveBeenCalledTimes(1); // no retries
	});

	it("applies exponential backoff", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("fail1"))
			.mockRejectedValueOnce(new Error("fail2"))
			.mockResolvedValue("success");

		const start = Date.now();
		await retryWithPolicy(fn, {
			maxRetries: 3,
			backoffMs: 10,
			backoffMultiplier: 2,
		});
		const elapsed = Date.now() - start;
		// Should have waited ~10ms + ~20ms = ~30ms minimum
		expect(elapsed).toBeGreaterThanOrEqual(20);
		expect(fn).toHaveBeenCalledTimes(3);
	});
});
