import { Command } from "commander";
import { input, password } from "@inquirer/prompts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getProjectDir,
	getAgentsDir,
	getSkillsDir,
	getVaultDir,
	getEnvPath,
	getConfigPath,
	hasProject,
} from "../lib/project.js";
import { success, info } from "../lib/output.js";
import { handleCommandError } from "../lib/errors.js";
import {
	getOrchestratorDefinition,
	DOCS_AGENTS,
	DOCS_SKILLS,
	DOCS_VAULT,
} from "../templates/orchestrator-system-prompt.js";

const ENV_TEMPLATE = `# Maximus project environment
# This file is loaded by the Maximus server on startup
CLAUDE_CODE_OAUTH_TOKEN=
MAXIMUS_VAULT_KEY=
`;

const MEMORY_EXTRACTOR_DEFINITION = `---
name: memory-extractor
description: Single-turn JSON entity extractor for the deep sleep memory pipeline. Receives a structured extraction prompt and returns raw JSON only.
model: sonnet
maxTurns: 1
---

You are a JSON extraction engine. You receive a prompt asking you to extract entities and relationships from agent episode data.

Respond with ONLY valid JSON — no explanation, no markdown fences, no preamble. Your entire response must be parseable by JSON.parse().
`;

const GITIGNORE_TEMPLATE = `# Maximus project - sensitive files
vault/
.env
maximus.pid
server.log
`;

function getDocsDir(): string {
	return join(getProjectDir(), "docs");
}

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Initialize a new Maximus project")
		.addHelpText("after", "\nExample:\n  $ maximus init")
		.action(async () => {
			try {
				await runInitWizard();
			} catch (err) {
				handleCommandError(err);
			}
		});
}

export async function runInitWizard(): Promise<void> {
	console.log();
	info("Initializing Maximus project...");
	console.log();

	if (hasProject()) {
		info("Project already initialized in ~/.maximus/");
		return;
	}

	const agentName = await input({
		message: "What's your agent's name?",
		default: "maximus",
	});

	// OAuth token
	let token: string;
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
		token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
		console.log("\x1b[2mUsing CLAUDE_CODE_OAUTH_TOKEN from environment\x1b[0m");
	} else {
		console.log(
			"\x1b[2mRun `claude setup-token` to get a token, then paste it here.\x1b[0m",
		);
		token = await password({ message: "OAuth token:" });
	}

	const vaultKey = await password({ message: "Vault encryption key:" });

	// Create directories
	mkdirSync(getProjectDir(), { recursive: true });
	mkdirSync(getAgentsDir(), { recursive: true });
	mkdirSync(getSkillsDir(), { recursive: true });
	mkdirSync(getVaultDir(), { recursive: true });
	mkdirSync(getDocsDir(), { recursive: true });
	mkdirSync(join(getProjectDir(), "memory"), { recursive: true });

	// Write config
	writeFileSync(
		getConfigPath(),
		JSON.stringify({ name: agentName, port: 4100 }, null, 2),
	);

	// Write orchestrator agent
	writeFileSync(
		join(getAgentsDir(), `${agentName}.md`),
		getOrchestratorDefinition(agentName),
	);

	// Write memory-extractor agent (required for deep-sleep entity extraction)
	writeFileSync(
		join(getAgentsDir(), "memory-extractor.md"),
		MEMORY_EXTRACTOR_DEFINITION,
	);

	// Write identity file
	writeFileSync(
		join(getProjectDir(), "identity.md"),
		`# ${agentName}\n\nOrchestrator agent for this Maximus instance.\n`,
	);

	// Write reference docs
	writeFileSync(join(getDocsDir(), "agents.md"), DOCS_AGENTS);
	writeFileSync(join(getDocsDir(), "skills.md"), DOCS_SKILLS);
	writeFileSync(join(getDocsDir(), "vault.md"), DOCS_VAULT);

	// Write .env with actual values
	writeFileSync(
		getEnvPath(),
		`# Maximus project environment\n# This file is loaded by the Maximus server on startup\nCLAUDE_CODE_OAUTH_TOKEN=${token}\nMAXIMUS_VAULT_KEY=${vaultKey}\n`,
	);

	// Write .gitignore
	writeFileSync(join(getProjectDir(), ".gitignore"), GITIGNORE_TEMPLATE);

	console.log();
	success("Project initialized!");
	console.log();
	info("Created:");
	console.log("  ~/.maximus/");
	console.log("    config.json");
	console.log("    identity.md");
	console.log(`    agents/${agentName}.md`);
	console.log("    agents/memory-extractor.md");
	console.log("    docs/");
	console.log("    memory/");
	console.log("    skills/");
	console.log("    vault/");
	console.log();
	info(`Run /start to launch the server, then say hello!`);
}
