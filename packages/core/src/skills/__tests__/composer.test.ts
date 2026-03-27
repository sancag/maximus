import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
	interpolateTemplate,
	filterOutputFields,
	composeSkillToMcpServer,
	type CredentialResolver,
} from "../composer.js";
import type { SkillDefinition } from "@maximus/shared";

// --- interpolateTemplate ---

describe("interpolateTemplate", () => {
	it("replaces {{variable}} placeholders with values from vars", () => {
		const result = interpolateTemplate(
			"https://api.github.com/repos/{{repo}}/issues",
			{ repo: "owner/name" },
		);
		expect(result).toBe("https://api.github.com/repos/owner/name/issues");
	});

	it("replaces credential placeholders in header values", () => {
		const result = interpolateTemplate("Bearer {{GITHUB_TOKEN}}", {
			GITHUB_TOKEN: "ghp_abc123",
		});
		expect(result).toBe("Bearer ghp_abc123");
	});

	it("replaces multiple variables in a single template", () => {
		const result = interpolateTemplate("{{a}} and {{b}}", {
			a: "hello",
			b: "world",
		});
		expect(result).toBe("hello and world");
	});

	it("throws when a template variable is missing from vars", () => {
		expect(() =>
			interpolateTemplate("{{missing}}", {}),
		).toThrow(/missing/);
	});

	it("returns string unchanged when no placeholders exist", () => {
		const result = interpolateTemplate("no placeholders here", {});
		expect(result).toBe("no placeholders here");
	});
});

// --- filterOutputFields ---

describe("filterOutputFields", () => {
	it("returns only keys in the include list", () => {
		const result = filterOutputFields(
			{ number: 1, html_url: "https://...", internal_id: "secret" },
			["number", "html_url"],
		);
		expect(result).toEqual({ number: 1, html_url: "https://..." });
	});

	it("returns entire object when no include list is provided", () => {
		const data = { a: 1, b: 2 };
		expect(filterOutputFields(data)).toEqual(data);
	});

	it("returns entire object when include list is empty", () => {
		const data = { a: 1, b: 2 };
		expect(filterOutputFields(data, [])).toEqual(data);
	});

	it("ignores include keys that are not in the data", () => {
		const result = filterOutputFields(
			{ number: 1 },
			["number", "nonexistent"],
		);
		expect(result).toEqual({ number: 1 });
	});
});

// --- Tool handler integration (composeSkillToMcpServer) ---

describe("composeSkillToMcpServer tool handler", () => {
	const mockTool = vi.fn();
	const mockCreateSdkMcpServer = vi.fn();

	beforeEach(() => {
		mockTool.mockImplementation(
			(
				_name: string,
				_desc: string,
				_params: Record<string, unknown>,
				handler: (args: Record<string, unknown>) => unknown,
			) => ({ handler }),
		);
		mockCreateSdkMcpServer.mockImplementation(
			(config: { tools: Array<{ handler: unknown }> }) => config,
		);

		vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
			createSdkMcpServer: mockCreateSdkMcpServer,
			tool: mockTool,
		}));
	});

	afterEach(() => {
		mockTool.mockClear();
		mockCreateSdkMcpServer.mockClear();
		vi.restoreAllMocks();
		vi.doUnmock("@anthropic-ai/claude-agent-sdk");
	});

	function makeSkill(toolOverrides: Record<string, unknown> = {}): SkillDefinition {
		return {
			name: "test-skill",
			description: "Test skill",
			version: "1.0",
			credentials: [
				{ name: "api_token", description: "API Token" },
			],
			tools: [
				{
					name: "test_tool",
					description: "A test tool",
					parameters: {
						repo: { type: "string" as const, description: "Repo", required: true },
					},
					credentials: [{ ref: "api_token", inject_as: "API_TOKEN" }],
					action: {
						type: "http" as const,
						method: "POST" as const,
						url: "https://api.example.com/repos/{{repo}}/issues",
						headers: { Authorization: "Bearer {{API_TOKEN}}" },
						body: { title: "{{repo}}" },
					},
					output: { include: ["id", "url"] },
					...toolOverrides,
				},
			],
			instructions: "",
		} as SkillDefinition;
	}

	const mockResolver: CredentialResolver = {
		resolve: vi.fn().mockResolvedValue("resolved_token_value"),
	};

	it("calls fetch with interpolated url, method, headers, and body", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: 42, url: "https://...", secret: "hidden" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const server = await composeSkillToMcpServer(makeSkill(), mockResolver);
		const handler = mockTool.mock.calls[0][3];
		const result = await handler({ repo: "owner/name" });

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.example.com/repos/owner/name/issues",
			expect.objectContaining({
				method: "POST",
				headers: { Authorization: "Bearer resolved_token_value" },
				body: JSON.stringify({ title: "owner/name" }),
			}),
		);

		fetchSpy.mockRestore();
	});

	it("applies output.include allowlist to response JSON", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: 42, url: "https://...", secret: "hidden" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const server = await composeSkillToMcpServer(makeSkill(), mockResolver);
		const handler = mockTool.mock.calls[0][3];
		const result = await handler({ repo: "owner/name" });

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed).toEqual({ id: 42, url: "https://..." });
		expect(parsed).not.toHaveProperty("secret");

		fetchSpy.mockRestore();
	});

	it("returns stub response when tool has no action field", async () => {
		// Ensure no leftover fetch mocks interfere
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("fetch should not be called"),
		);

		const skillWithoutAction = makeSkill({ action: undefined, output: undefined });
		const server = await composeSkillToMcpServer(
			skillWithoutAction,
			mockResolver,
		);
		const handler = mockTool.mock.calls[0][3];
		const result = await handler({ repo: "owner/name" });

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed).toEqual({
			status: "tool_executed",
			tool: "test_tool",
			args: { repo: "owner/name" },
		});
		expect(fetchSpy).not.toHaveBeenCalled();

		fetchSpy.mockRestore();
	});

	it("returns isError: true on fetch failure", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("Network error"),
		);

		const server = await composeSkillToMcpServer(makeSkill(), mockResolver);
		const handler = mockTool.mock.calls[0][3];
		const result = await handler({ repo: "owner/name" });

		expect(result.isError).toBe(true);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.error).toContain("Tool execution failed");

		fetchSpy.mockRestore();
	});

	it("returns isError: true on non-ok HTTP response", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("Not Found", { status: 404, statusText: "Not Found" }),
		);

		const server = await composeSkillToMcpServer(makeSkill(), mockResolver);
		const handler = mockTool.mock.calls[0][3];
		const result = await handler({ repo: "owner/name" });

		expect(result.isError).toBe(true);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.error).toContain("404");

		fetchSpy.mockRestore();
	});
});
