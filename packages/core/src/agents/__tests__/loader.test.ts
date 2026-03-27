import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Imports will fail until implementation exists
import { loadAgentDefinition, loadAgentsFromDirectory } from "../loader.js";
import { AgentRegistry } from "../registry.js";

const EXAMPLE_AGENT_PATH = path.resolve(
	import.meta.dirname,
	"../../../../../agents/example-agent.md",
);

describe("loadAgentDefinition", () => {
	it("parses a valid Markdown agent file into AgentDefinition", () => {
		const agent = loadAgentDefinition(EXAMPLE_AGENT_PATH);

		expect(agent.name).toBe("engineering-lead");
		expect(agent.description).toBe(
			"Engineering team manager who breaks down complex tasks",
		);
		expect(agent.model).toBe("sonnet");
		expect(agent.maxTurns).toBe(30);
		expect(agent.skills).toEqual(["github-operations"]);
		expect(agent.prompt).toContain("pragmatic engineering manager");
		expect(agent.filePath).toBe(EXAMPLE_AGENT_PATH);
	});

	it("throws with descriptive error when name field is missing", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
		const badFile = path.join(tmpDir, "bad-agent.md");
		fs.writeFileSync(
			badFile,
			`---
description: Missing name
---
Some prompt.
`,
		);

		expect(() => loadAgentDefinition(badFile)).toThrow(/name/i);

		fs.rmSync(tmpDir, { recursive: true });
	});

	it("throws on non-existent file", () => {
		expect(() =>
			loadAgentDefinition("/nonexistent/path/agent.md"),
		).toThrow(/ENOENT|not found/i);
	});

	it("applies default values for optional fields", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
		const minimalFile = path.join(tmpDir, "minimal.md");
		fs.writeFileSync(
			minimalFile,
			`---
name: minimal-agent
description: A minimal agent
---
Do things.
`,
		);

		const agent = loadAgentDefinition(minimalFile);
		expect(agent.model).toBe("sonnet");
		expect(agent.maxTurns).toBe(25);
		expect(agent.skills).toEqual([]);

		fs.rmSync(tmpDir, { recursive: true });
	});
});

describe("loadAgentsFromDirectory", () => {
	it("loads all .md files from a directory", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
		fs.writeFileSync(
			path.join(tmpDir, "a.md"),
			`---
name: agent-a
description: Agent A
---
Prompt A.
`,
		);
		fs.writeFileSync(
			path.join(tmpDir, "b.md"),
			`---
name: agent-b
description: Agent B
---
Prompt B.
`,
		);
		// Non-md file should be ignored
		fs.writeFileSync(path.join(tmpDir, "readme.txt"), "ignore me");

		const agents = loadAgentsFromDirectory(tmpDir);
		expect(agents).toHaveLength(2);
		expect(agents.map((a) => a.name).sort()).toEqual(["agent-a", "agent-b"]);

		fs.rmSync(tmpDir, { recursive: true });
	});
});

describe("AgentRegistry", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		registry = new AgentRegistry();
	});

	it("registers and retrieves an agent by name", () => {
		const agent = loadAgentDefinition(EXAMPLE_AGENT_PATH);
		registry.register(agent);

		const retrieved = registry.get("engineering-lead");
		expect(retrieved).toBe(agent);
	});

	it("throws when getting a nonexistent agent", () => {
		expect(() => registry.get("nonexistent")).toThrow(/not found/i);
	});

	it("returns all registered agents via getAll()", () => {
		const agent = loadAgentDefinition(EXAMPLE_AGENT_PATH);
		registry.register(agent);

		const all = registry.getAll();
		expect(all).toHaveLength(1);
		expect(all[0].name).toBe("engineering-lead");
	});

	it("loads agents from directory via loadFromDirectory()", () => {
		const agentsDir = path.resolve(
			import.meta.dirname,
			"../../../../../agents",
		);
		registry.loadFromDirectory(agentsDir);

		expect(registry.has("engineering-lead")).toBe(true);
		expect(registry.getAll().length).toBeGreaterThanOrEqual(1);
	});
});
