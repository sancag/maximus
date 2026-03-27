import { describe, it, expect, beforeEach } from "vitest";
import { Command } from "commander";
import { registerInitCommand } from "../commands/init.js";
import { registerVaultCommand } from "../commands/vault.js";
import { registerAgentsCommand } from "../commands/agents.js";
import { registerSkillsCommand } from "../commands/skills.js";

function createTestProgram(capture: { output: string }): Command {
	const outputConfig = {
		writeOut: (str: string) => {
			capture.output += str;
		},
		writeErr: (str: string) => {
			capture.output += str;
		},
	};

	const program = new Command();
	program
		.name("maximus")
		.description("Manage teams of Claude agents")
		.version("0.1.0")
		.exitOverride()
		.configureOutput(outputConfig);

	registerInitCommand(program);
	registerVaultCommand(program);
	registerAgentsCommand(program);
	registerSkillsCommand(program);

	// Propagate exitOverride and configureOutput to all subcommands
	for (const cmd of program.commands) {
		cmd.exitOverride().configureOutput(outputConfig);
		for (const sub of cmd.commands) {
			sub.exitOverride().configureOutput(outputConfig);
		}
	}

	return program;
}

describe("CLI Program", () => {
	let program: Command;
	let capture: { output: string };

	beforeEach(() => {
		capture = { output: "" };
		program = createTestProgram(capture);
	});

	it("shows all command groups in --help", async () => {
		try {
			await program.parseAsync(["node", "maximus", "--help"]);
		} catch {
			// exitOverride throws on --help
		}
		expect(capture.output).toContain("maximus");
		expect(capture.output).toContain("init");
		expect(capture.output).toContain("vault");
		expect(capture.output).toContain("agents");
		expect(capture.output).toContain("skills");
	});

	it("shows version with --version", async () => {
		try {
			await program.parseAsync(["node", "maximus", "--version"]);
		} catch {
			// exitOverride throws on --version
		}
		expect(capture.output).toContain("0.1.0");
	});

	it("vault --help shows subcommands", async () => {
		try {
			await program.parseAsync(["node", "maximus", "vault", "--help"]);
		} catch {
			// exitOverride throws on --help
		}
		expect(capture.output).toContain("set");
		expect(capture.output).toContain("get");
		expect(capture.output).toContain("list");
		expect(capture.output).toContain("delete");
	});

	it("agents --help shows subcommands", async () => {
		try {
			await program.parseAsync(["node", "maximus", "agents", "--help"]);
		} catch {
			// exitOverride throws on --help
		}
		expect(capture.output).toContain("list");
		expect(capture.output).toContain("org-chart");
	});

	it("skills --help shows subcommands", async () => {
		try {
			await program.parseAsync(["node", "maximus", "skills", "--help"]);
		} catch {
			// exitOverride throws on --help
		}
		expect(capture.output).toContain("list");
	});
});
