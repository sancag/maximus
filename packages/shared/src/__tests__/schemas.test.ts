import { describe, it, expect } from "vitest";
import { agentFrontmatterSchema } from "../agents.js";
import { skillSchema } from "../skills.js";
import { credentialRefSchema } from "../credentials.js";

describe("agentFrontmatterSchema", () => {
	it("parses minimal valid agent (name + description)", () => {
		const result = agentFrontmatterSchema.parse({
			name: "test",
			description: "test agent",
		});
		expect(result.name).toBe("test");
		expect(result.description).toBe("test agent");
		expect(result.model).toBe("sonnet");
		expect(result.maxTurns).toBe(25);
		expect(result.skills).toEqual([]);
	});

	it("parses full valid agent with all fields", () => {
		const result = agentFrontmatterSchema.parse({
			name: "test",
			description: "test agent",
			model: "sonnet",
			maxTurns: 30,
			skills: ["github"],
		});
		expect(result.model).toBe("sonnet");
		expect(result.maxTurns).toBe(30);
		expect(result.skills).toEqual(["github"]);
	});

	it("throws ZodError on empty object (missing required fields)", () => {
		expect(() => agentFrontmatterSchema.parse({})).toThrow();
	});

	it("throws ZodError on invalid model", () => {
		expect(() =>
			agentFrontmatterSchema.parse({
				name: "test",
				description: "test",
				model: "gpt4",
			}),
		).toThrow();
	});
});

describe("skillSchema", () => {
	it("parses valid skill with tools, credentials, and instructions", () => {
		const validSkill = {
			name: "github-operations",
			description: "Manage GitHub repos",
			version: "1.0",
			credentials: [
				{ name: "github_token", description: "GitHub PAT" },
			],
			tools: [
				{
					name: "github_create_issue",
					description: "Create an issue",
					parameters: {
						repo: {
							type: "string",
							description: "Repository in owner/name format",
						},
					},
				},
			],
			instructions: "Always check before creating",
		};
		const result = skillSchema.parse(validSkill);
		expect(result.name).toBe("github-operations");
		expect(result.tools).toHaveLength(1);
		expect(result.credentials).toHaveLength(1);
		expect(result.instructions).toBe("Always check before creating");
	});

	it("throws ZodError when tools array is missing", () => {
		expect(() =>
			skillSchema.parse({ name: "test" }),
		).toThrow();
	});
});

describe("credentialRefSchema", () => {
	it("parses valid credential ref", () => {
		const result = credentialRefSchema.parse({
			name: "github_token",
			description: "GitHub PAT",
		});
		expect(result.name).toBe("github_token");
		expect(result.description).toBe("GitHub PAT");
	});
});

describe("index re-exports", () => {
	it("re-exports all schemas from index", async () => {
		const index = await import("../index.js");
		expect(index.agentFrontmatterSchema).toBeDefined();
		expect(index.skillSchema).toBeDefined();
		expect(index.credentialRefSchema).toBeDefined();
	});
});
