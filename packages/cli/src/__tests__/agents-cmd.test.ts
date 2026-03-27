import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock api-client before importing commands
vi.mock("../lib/api-client.js", () => ({
	apiGet: vi.fn(),
	getBaseUrl: vi.fn().mockReturnValue("http://127.0.0.1:4100"),
}));

import { apiGet } from "../lib/api-client.js";

const mockedApiGet = vi.mocked(apiGet);

describe("agents list", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("shows table with agent names", async () => {
		mockedApiGet.mockResolvedValue({
			agents: [
				{
					name: "orchestrator",
					description: "Top-level orchestrator",
					model: "sonnet",
					skills: [],
					reportsTo: null,
				},
				{
					name: "worker",
					description: "Worker agent",
					model: "haiku",
					skills: ["search"],
					reportsTo: "orchestrator",
				},
			],
		});

		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args.join(" "));
		});

		const { registerAgentsCommand } = await import(
			"../commands/agents.js"
		);
		const { Command } = await import("commander");
		const program = new Command();
		program.exitOverride();
		registerAgentsCommand(program);

		await program.parseAsync(["node", "test", "agents", "list"]);

		spy.mockRestore();

		const output = logs.join("\n");
		expect(output).toContain("orchestrator");
		expect(output).toContain("worker");
	});

	it("agents list --json outputs parseable JSON", async () => {
		mockedApiGet.mockResolvedValue({
			agents: [
				{
					name: "orchestrator",
					description: "Top-level orchestrator",
					model: "sonnet",
					skills: [],
					reportsTo: null,
				},
				{
					name: "worker",
					description: "Worker agent",
					model: "haiku",
					skills: ["search"],
					reportsTo: "orchestrator",
				},
			],
		});

		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args.join(" "));
		});

		const { registerAgentsCommand } = await import(
			"../commands/agents.js"
		);
		const { Command } = await import("commander");
		const program = new Command();
		program.exitOverride();
		registerAgentsCommand(program);

		await program.parseAsync([
			"node",
			"test",
			"agents",
			"list",
			"--json",
		]);

		spy.mockRestore();

		const output = logs.join("\n");
		const parsed = JSON.parse(output);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toHaveProperty("name");
		expect(parsed[0]).toHaveProperty("description");
		expect(parsed[0]).toHaveProperty("model");
		expect(parsed[0]).toHaveProperty("skills");
		expect(parsed[0]).toHaveProperty("reportsTo");
	});

	it("shows skills count for agents", async () => {
		mockedApiGet.mockResolvedValue({
			agents: [
				{
					name: "worker",
					description: "Worker agent",
					model: "haiku",
					skills: ["search", "write"],
					reportsTo: null,
				},
			],
		});

		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args.join(" "));
		});

		const { registerAgentsCommand } = await import(
			"../commands/agents.js"
		);
		const { Command } = await import("commander");
		const program = new Command();
		program.exitOverride();
		registerAgentsCommand(program);

		await program.parseAsync(["node", "test", "agents", "list"]);

		spy.mockRestore();

		const output = logs.join("\n");
		// Table should show "2" for skills count
		expect(output).toContain("2");
	});

	it("shows reports-to relationship", async () => {
		mockedApiGet.mockResolvedValue({
			agents: [
				{
					name: "worker",
					description: "Worker",
					model: "haiku",
					skills: [],
					reportsTo: "orchestrator",
				},
			],
		});

		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args.join(" "));
		});

		const { registerAgentsCommand } = await import(
			"../commands/agents.js"
		);
		const { Command } = await import("commander");
		const program = new Command();
		program.exitOverride();
		registerAgentsCommand(program);

		await program.parseAsync(["node", "test", "agents", "list"]);

		spy.mockRestore();

		const output = logs.join("\n");
		expect(output).toContain("orchestrator");
	});

	it("org-chart renders tree with box-drawing characters", async () => {
		mockedApiGet.mockResolvedValue({
			agents: [
				{ name: "orchestrator", reportsTo: null },
				{ name: "worker", reportsTo: "orchestrator" },
			],
		});

		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args.join(" "));
		});

		const { registerAgentsCommand } = await import(
			"../commands/agents.js"
		);
		const { Command } = await import("commander");
		const program = new Command();
		program.exitOverride();
		registerAgentsCommand(program);

		await program.parseAsync(["node", "test", "agents", "org-chart"]);

		spy.mockRestore();

		const output = logs.join("\n");
		expect(output).toContain("orchestrator");
		// Check for box-drawing characters
		const hasBoxChars =
			output.includes("\u251C") ||
			output.includes("\u2514") ||
			output.includes("\u2502");
		expect(hasBoxChars).toBe(true);
	});

	it("org-chart shows hierarchy with worker under orchestrator", async () => {
		mockedApiGet.mockResolvedValue({
			agents: [
				{ name: "orchestrator", reportsTo: null },
				{ name: "worker", reportsTo: "orchestrator" },
			],
		});

		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args.join(" "));
		});

		const { registerAgentsCommand } = await import(
			"../commands/agents.js"
		);
		const { Command } = await import("commander");
		const program = new Command();
		program.exitOverride();
		registerAgentsCommand(program);

		await program.parseAsync(["node", "test", "agents", "org-chart"]);

		spy.mockRestore();

		const output = logs.join("\n");
		// orchestrator should appear before worker
		const orchIdx = output.indexOf("orchestrator");
		const workerIdx = output.indexOf("worker");
		expect(orchIdx).toBeLessThan(workerIdx);
	});

	it("warns when no agents found", async () => {
		mockedApiGet.mockResolvedValue({ agents: [] });

		const warns: string[] = [];
		const spy = vi
			.spyOn(console, "warn")
			.mockImplementation((...args) => {
				warns.push(args.join(" "));
			});

		const { registerAgentsCommand } = await import(
			"../commands/agents.js"
		);
		const { Command } = await import("commander");
		const program = new Command();
		program.exitOverride();
		registerAgentsCommand(program);

		await program.parseAsync(["node", "test", "agents", "list"]);

		spy.mockRestore();

		const output = warns.join("\n");
		expect(output).toContain("No agents loaded");
	});
});
