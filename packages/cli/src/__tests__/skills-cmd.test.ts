import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock api-client before importing commands
vi.mock("../lib/api-client.js", () => ({
	apiGet: vi.fn(),
	getBaseUrl: vi.fn().mockReturnValue("http://127.0.0.1:4100"),
}));

import { apiGet } from "../lib/api-client.js";

const mockedApiGet = vi.mocked(apiGet);

describe("skills list", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("shows table with skill names", async () => {
		mockedApiGet.mockResolvedValue({
			skills: [
				{
					name: "test-skill",
					description: "A test skill",
					toolCount: 1,
					credentials: ["api_key"],
				},
			],
		});

		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args.join(" "));
		});

		const { registerSkillsCommand } = await import(
			"../commands/skills.js"
		);
		const { Command } = await import("commander");
		const program = new Command();
		program.exitOverride();
		registerSkillsCommand(program);

		await program.parseAsync(["node", "test", "skills", "list"]);

		spy.mockRestore();

		const output = logs.join("\n");
		expect(output).toContain("test-skill");
	});

	it("--json outputs parseable JSON with correct fields", async () => {
		mockedApiGet.mockResolvedValue({
			skills: [
				{
					name: "test-skill",
					description: "A test skill",
					toolCount: 1,
					credentials: ["api_key"],
				},
			],
		});

		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args.join(" "));
		});

		const { registerSkillsCommand } = await import(
			"../commands/skills.js"
		);
		const { Command } = await import("commander");
		const program = new Command();
		program.exitOverride();
		registerSkillsCommand(program);

		await program.parseAsync([
			"node",
			"test",
			"skills",
			"list",
			"--json",
		]);

		spy.mockRestore();

		const output = logs.join("\n");
		const parsed = JSON.parse(output);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].toolCount).toBe(1);
		expect(parsed[0].credentials).toEqual(["api_key"]);
	});

	it("shows tool count in table", async () => {
		mockedApiGet.mockResolvedValue({
			skills: [
				{
					name: "test-skill",
					description: "A test skill",
					toolCount: 1,
					credentials: ["api_key"],
				},
			],
		});

		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args.join(" "));
		});

		const { registerSkillsCommand } = await import(
			"../commands/skills.js"
		);
		const { Command } = await import("commander");
		const program = new Command();
		program.exitOverride();
		registerSkillsCommand(program);

		await program.parseAsync(["node", "test", "skills", "list"]);

		spy.mockRestore();

		const output = logs.join("\n");
		// Table should contain "1" for the tool count
		expect(output).toContain("1");
	});

	it("shows credentials in table", async () => {
		mockedApiGet.mockResolvedValue({
			skills: [
				{
					name: "test-skill",
					description: "A test skill",
					toolCount: 1,
					credentials: ["api_key"],
				},
			],
		});

		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args.join(" "));
		});

		const { registerSkillsCommand } = await import(
			"../commands/skills.js"
		);
		const { Command } = await import("commander");
		const program = new Command();
		program.exitOverride();
		registerSkillsCommand(program);

		await program.parseAsync(["node", "test", "skills", "list"]);

		spy.mockRestore();

		const output = logs.join("\n");
		expect(output).toContain("api_key");
	});

	it("warns when no skills found", async () => {
		mockedApiGet.mockResolvedValue({ skills: [] });

		const warns: string[] = [];
		const spy = vi
			.spyOn(console, "warn")
			.mockImplementation((...args) => {
				warns.push(args.join(" "));
			});

		const { registerSkillsCommand } = await import(
			"../commands/skills.js"
		);
		const { Command } = await import("commander");
		const program = new Command();
		program.exitOverride();
		registerSkillsCommand(program);

		await program.parseAsync(["node", "test", "skills", "list"]);

		spy.mockRestore();

		const output = warns.join("\n");
		expect(output).toContain("No skills loaded");
	});
});
