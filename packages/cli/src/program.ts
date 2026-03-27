import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerVaultCommand } from "./commands/vault.js";
import { registerAgentsCommand } from "./commands/agents.js";
import { registerSkillsCommand } from "./commands/skills.js";
import { registerServerCommand } from "./commands/server.js";
import { registerChatCommand } from "./commands/chat.js";
import { registerMemoryCommand } from "./commands/memory.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import chalk from "chalk";
import { handleCommandError } from "./lib/errors.js";
import { printBanner, printHeader, formatHelpSection, type ServerStatus } from "./lib/output.js";
import { readPid, isProcessRunning } from "./lib/pid.js";
import { formatUptime } from "./commands/server.js";
import { statSync } from "node:fs";

const VERSION = "0.1.0";
const dimGold = chalk.hex("#C4851A");
const darkGold = chalk.hex("#8B6914");

async function getServerStatus(): Promise<ServerStatus | undefined> {
	try {
		const pid = readPid();
		if (pid === null || !isProcessRunning(pid)) return undefined;

		const { getPidPath } = await import("./lib/project.js");
		const startTime = statSync(getPidPath()).mtimeMs;
		const uptimeMs = Date.now() - startTime;

		const { apiGet } = await import("./lib/api-client.js");
		const [agentsData, tasksData] = await Promise.all([
			apiGet<{ agents: Array<Record<string, unknown>> }>("/api/agents").catch(() => ({ agents: [] })),
			apiGet<{ tasks: Array<{ status: string }> }>("/api/tasks").catch(() => ({ tasks: [] })),
		]);

		const agents = agentsData.agents ?? [];
		const tasks = tasksData.tasks ?? [];

		return {
			running: true,
			agents: {
				active: agents.length,
				idle: 0,
			},
			tasks: {
				running: tasks.filter((t) => t.status === "in-progress").length,
				pending: tasks.filter((t) => t.status === "created" || t.status === "assigned").length,
			},
			uptime: formatUptime(uptimeMs),
		};
	} catch {
		return undefined;
	}
}

async function printBrandedHelp(): Promise<void> {
	const gold = chalk.hex("#E8A422");
	const status = await getServerStatus();

	printHeader();
	console.log(`  ${dimGold("agent orchestration platform")}`);
	console.log(`  ${darkGold(`v${VERSION}`)}  ${darkGold("·")}  ${darkGold("MIT license")}`);

	if (status?.running) {
		const a = status.agents ?? {};
		const t = status.tasks ?? {};
		console.log();
		console.log(`  ${dimGold("agents")}  ${gold(`${a.active ?? 0} active`)}  ${darkGold("·")}  ${dimGold(`${a.idle ?? 0} idle`)}`);
		console.log(`  ${dimGold("tasks")}   ${gold(`${t.running ?? 0} running`)}  ${darkGold("·")}  ${dimGold(`${t.pending ?? 0} pending`)}`);
		console.log(`  ${dimGold("uptime")}  ${dimGold(status.uptime ?? "0s")}`);
	}

	formatHelpSection("Commands", [
		{ name: "maximus init", desc: "Initialize a new Maximus project" },
		{ name: "maximus server start", desc: "Launch the server" },
		{ name: "maximus server status", desc: "Show server status" },
		{ name: "maximus doctor", desc: "Check configuration health" },
		{ name: "maximus agents list", desc: "List agent definitions" },
		{ name: "maximus agents org-chart", desc: "Display agent hierarchy" },
		{ name: "maximus skills list", desc: "List skill definitions" },
		{ name: "maximus vault set <name>", desc: "Store a credential" },
		{ name: "maximus vault list", desc: "List stored credentials" },
		{ name: "maximus memory status", desc: "Show memory system status" },
		{ name: "maximus memory inspect", desc: "Inspect agent memory" },
		{ name: "maximus chat [message]", desc: "Chat with the orchestrator" },
	]);

	formatHelpSection("Options", [
		{ name: "--help, -h", desc: "Show help for any command" },
		{ name: "--version, -V", desc: "Show version number" },
		{ name: "--json", desc: "Machine-readable output (on list/status)" },
	]);

	console.log();
	console.log(`  ${dimGold("Or just run")} ${gold("maximus")} ${dimGold("to start the interactive TUI")}`);
	console.log();
}

export const program = new Command();

program
	.name("maximus")
	.description("Manage teams of Claude agents")
	.version(VERSION)
	.exitOverride()
	.configureOutput({
		writeErr: (str) => process.stderr.write(str),
		writeOut: (str) => process.stdout.write(str),
	})
	.addHelpCommand(false)
	.helpOption(false)
	.option("-h, --help", "display help")
	.action(async (opts) => {
		if (opts.help) {
			await printBrandedHelp();
			return;
		}
		// Launch Ink TUI when no subcommand given
		const { startTui } = await import('./tui/index.js');
		await startTui();
	});

registerInitCommand(program);
registerVaultCommand(program);
registerAgentsCommand(program);
registerSkillsCommand(program);
registerServerCommand(program);
registerChatCommand(program);
registerMemoryCommand(program);
registerDoctorCommand(program);

program.exitOverride((err) => {
	throw err;
});
