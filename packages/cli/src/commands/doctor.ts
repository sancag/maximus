import { Command } from "commander";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import {
	getProjectDir,
	hasProject,
	getAgentsDir,
	getSkillsDir,
	getVaultPath,
	loadProjectEnv,
} from "../lib/project.js";
import { handleCommandError } from "../lib/errors.js";

interface Check {
	name: string;
	status: "pass" | "warn" | "fail";
	message: string;
	detail?: string;
}

interface SubsystemResult {
	label: string;
	checks: Check[];
}

function checkAgents(agentsDir: string): Check[] {
	const checks: Check[] = [];

	if (!existsSync(agentsDir)) {
		checks.push({
			name: "Agents directory",
			status: "fail",
			message: `No agents directory at ${agentsDir}. Create it or run \`maximus init\`.`,
		});
		return checks;
	}

	const mdFiles = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));

	if (mdFiles.length === 0) {
		checks.push({
			name: "Agent definitions",
			status: "warn",
			message: `No agent definitions found in ${agentsDir}.`,
		});
		return checks;
	}

	let memoryCount = 0;
	for (const file of mdFiles) {
		const content = readFileSync(join(agentsDir, file), "utf-8");
		const frontmatter = parseFrontmatter(content);

		if (frontmatter) {
			if (!frontmatter.name) {
				checks.push({
					name: "Agent frontmatter",
					status: "warn",
					message: `${file} missing \`name\` field.`,
				});
			}
			if (frontmatter.memory) {
				memoryCount++;
			}
		}
	}

	checks.push({
		name: "Agents",
		status: "pass",
		message: `${mdFiles.length} agent definition(s) found.`,
		detail: `${memoryCount} of ${mdFiles.length} agents have memory enabled.`,
	});

	return checks;
}

async function checkMemory(projectDir: string): Promise<Check[]> {
	const checks: Check[] = [];
	const memoryDir =
		process.env.MAXIMUS_MEMORY_DIR ?? join(projectDir, "memory");

	if (!existsSync(memoryDir)) {
		checks.push({
			name: "Memory directory",
			status: "warn",
			message: `No memory directory at ${memoryDir}. Memory will be created on first server start.`,
		});
		return checks;
	}

	const operationalDb = join(memoryDir, "operational.db");
	const knowledgeDir = join(memoryDir, "knowledge.kuzu");

	if (!existsSync(operationalDb)) {
		checks.push({
			name: "Operational DB",
			status: "warn",
			message: "operational.db not found in memory directory.",
		});
	}

	if (!existsSync(knowledgeDir)) {
		checks.push({
			name: "Knowledge graph",
			status: "warn",
			message: "knowledge.kuzu directory not found in memory directory.",
		});
	}

	let episodeCount: number | null = null;
	let lastConsolidation: string | null = null;

	if (existsSync(operationalDb)) {
		try {
			// @ts-expect-error -- no @types/better-sqlite3 in cli package
			const Database = (await import("better-sqlite3")).default;
			const db = new Database(operationalDb, { readonly: true });
			try {
				const row = db
					.prepare("SELECT COUNT(*) as count FROM episodes")
					.get() as { count: number } | undefined;
				episodeCount = row?.count ?? 0;
			} catch {
				// Table may not exist
			}
			try {
				const row = db
					.prepare(
						"SELECT MAX(createdAt) as last FROM consolidation_runs",
					)
					.get() as { last: string | null } | undefined;
				lastConsolidation = row?.last ?? null;
			} catch {
				// Table may not exist
			}
			db.close();
		} catch {
			checks.push({
				name: "Memory DB",
				status: "warn",
				message:
					"Could not open operational.db (better-sqlite3 may not be available).",
			});
		}
	}

	const detailParts: string[] = [];
	if (episodeCount !== null) {
		detailParts.push(`${episodeCount} episodes`);
	}
	detailParts.push(
		`Last consolidation: ${lastConsolidation ?? "Never"}`,
	);

	checks.push({
		name: "Memory system",
		status: "pass",
		message: "Memory system configured.",
		detail: detailParts.join(". ") + ".",
	});

	return checks;
}

function checkVault(_projectDir: string): Check[] {
	const checks: Check[] = [];
	const vaultPath = getVaultPath();

	if (!existsSync(vaultPath)) {
		checks.push({
			name: "Vault file",
			status: "warn",
			message:
				"No vault file. Run `maximus vault set <name>` to create.",
		});
	}

	if (!process.env.MAXIMUS_VAULT_KEY) {
		checks.push({
			name: "Vault key",
			status: "warn",
			message:
				"MAXIMUS_VAULT_KEY not set. Vault will prompt for key or fail in non-interactive mode.",
		});
	}

	if (existsSync(vaultPath) && process.env.MAXIMUS_VAULT_KEY) {
		checks.push({
			name: "Vault",
			status: "pass",
			message: "Vault configured.",
		});
	}

	return checks;
}

function checkTraces(projectDir: string): Check[] {
	const checks: Check[] = [];
	const tracesDir =
		process.env.MAXIMUS_TRACES_DIR ?? join(projectDir, "traces");

	if (!existsSync(tracesDir)) {
		checks.push({
			name: "Traces directory",
			status: "info" as Check["status"],
			message:
				"No traces directory. Will be created on first agent run.",
		});
		// info isn't a valid status, use pass with detail
		checks.length = 0;
		checks.push({
			name: "Traces",
			status: "pass",
			message:
				"No traces directory. Will be created on first agent run.",
		});
		return checks;
	}

	const traceFiles = readdirSync(tracesDir).filter((f) =>
		f.endsWith(".jsonl"),
	);
	checks.push({
		name: "Traces",
		status: "pass",
		message: `${traceFiles.length} trace file(s) found.`,
	});

	return checks;
}

function checkDeepSleep(agentsDir: string): Check[] {
	const checks: Check[] = [];

	if (!existsSync(join(agentsDir, "memory-extractor.md"))) {
		checks.push({
			name: "Haiku extractor",
			status: "warn",
			message:
				"No memory-extractor agent. Entity extraction during deep sleep will be skipped.",
		});
	}

	const schedule =
		process.env.MAXIMUS_DEEP_SLEEP_SCHEDULE ?? "0 3 * * *";
	checks.push({
		name: "Deep sleep",
		status: "pass",
		message: `Deep sleep scheduled: ${schedule}.`,
	});

	return checks;
}

function checkSkills(skillsDir: string): Check[] {
	const checks: Check[] = [];

	if (!existsSync(skillsDir)) {
		checks.push({
			name: "Skills",
			status: "pass",
			message: `No skills directory at ${skillsDir}.`,
		});
		return checks;
	}

	const skillFiles = readdirSync(skillsDir).filter(
		(f) => f.endsWith(".yaml") || f.endsWith(".yml"),
	);

	if (skillFiles.length === 0) {
		checks.push({
			name: "Skills",
			status: "pass",
			message: "No skill definitions found.",
		});
	} else {
		checks.push({
			name: "Skills",
			status: "pass",
			message: `${skillFiles.length} skill definition(s) found.`,
		});
	}

	return checks;
}

function parseFrontmatter(
	content: string,
): Record<string, unknown> | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return null;

	const result: Record<string, unknown> = {};
	for (const line of match[1].split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		if (value === "" || value === "true") {
			result[key] = value === "" ? true : true;
		} else if (value === "false") {
			result[key] = false;
		} else {
			result[key] = value;
		}
	}
	return result;
}

const STATUS_LABEL: Record<Check["status"], string> = {
	pass: chalk.green("PASS"),
	warn: chalk.yellow("WARN"),
	fail: chalk.red("FAIL"),
};

function renderChecks(subsystems: SubsystemResult[]): void {
	let passCount = 0;
	let warnCount = 0;
	let failCount = 0;

	for (const subsystem of subsystems) {
		console.log();
		console.log(`  ${chalk.bold(subsystem.label)}`);
		for (const check of subsystem.checks) {
			console.log(
				`    ${STATUS_LABEL[check.status]}  ${check.name} - ${check.message}`,
			);
			if (check.detail) {
				console.log(`         ${chalk.dim(check.detail)}`);
			}
			if (check.status === "pass") passCount++;
			else if (check.status === "warn") warnCount++;
			else failCount++;
		}
	}

	console.log();
	console.log(
		`  ${chalk.green(`${passCount} passed`)}, ${chalk.yellow(`${warnCount} warnings`)}, ${chalk.red(`${failCount} failures`)}`,
	);
	console.log();
}

export function registerDoctorCommand(parent: Command): void {
	parent
		.command("doctor")
		.description("Check configuration health across all subsystems")
		.option("--json", "Output results as JSON")
		.action(async (opts) => {
			try {
				if (!hasProject()) {
					const failResult: SubsystemResult[] = [
						{
							label: "Project",
							checks: [
								{
									name: "Project directory",
									status: "fail",
									message:
										"No .maximus/ directory found. Run `maximus init` first.",
								},
							],
						},
					];

					if (opts.json) {
						const allChecks = failResult.flatMap(
							(s) => s.checks,
						);
						console.log(JSON.stringify(allChecks, null, 2));
					} else {
						renderChecks(failResult);
					}
					process.exit(1);
				}

				loadProjectEnv();

				const projectDir = getProjectDir();
				const agentsDir = getAgentsDir();
				const skillsDir = getSkillsDir();

				const subsystems: SubsystemResult[] = [
					{ label: "Agents", checks: checkAgents(agentsDir) },
					{
						label: "Memory",
						checks: await checkMemory(projectDir),
					},
					{ label: "Vault", checks: checkVault(projectDir) },
					{ label: "Traces", checks: checkTraces(projectDir) },
					{
						label: "Deep Sleep",
						checks: checkDeepSleep(agentsDir),
					},
					{ label: "Skills", checks: checkSkills(skillsDir) },
				];

				const allChecks = subsystems.flatMap((s) => s.checks);

				if (opts.json) {
					console.log(JSON.stringify(allChecks, null, 2));
				} else {
					renderChecks(subsystems);
				}

				const hasFail = allChecks.some(
					(c) => c.status === "fail",
				);
				process.exit(hasFail ? 1 : 0);
			} catch (error) {
				handleCommandError(error);
			}
		});
}
