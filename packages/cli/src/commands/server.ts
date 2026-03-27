import { Command } from "commander";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { AgentRegistry } from "@maximus/core";
import { getConfig } from "../lib/config.js";
import { getAgentsDir, getSkillsDir, getVaultPath, getPidPath } from "../lib/project.js";
import { readPid, writePid, removePid, isProcessRunning } from "../lib/pid.js";
import { success, info, warn, createTable } from "../lib/output.js";
import { errorMessage, handleCommandError } from "../lib/errors.js";

function resolveServerScript(): string {
	// Resolve @maximus/server main.ts via workspace package location
	const pkgJson = require.resolve("@maximus/server/package.json");
	return path.join(path.dirname(pkgJson), "src", "main.ts");
}

function resolveTsx(): string {
	const pkgJson = require.resolve("tsx/package.json");
	return path.join(path.dirname(pkgJson), "dist", "cli.mjs");
}

export function formatUptime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

function countAgents(agentsDir: string): number {
	try {
		const registry = new AgentRegistry();
		registry.loadFromDirectory(agentsDir);
		return registry.getAll().length;
	} catch {
		return 0;
	}
}

async function stopServer(): Promise<boolean> {
	const pid = readPid();

	if (pid === null) return false;

	if (!isProcessRunning(pid)) {
		removePid();
		return false;
	}

	info(`Stopping server (PID ${pid})...`);
	process.kill(pid, "SIGTERM");

	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (!isProcessRunning(pid)) break;
		await new Promise((r) => setTimeout(r, 200));
	}

	if (isProcessRunning(pid)) {
		warn("Server did not stop gracefully, sending SIGKILL...");
		process.kill(pid, "SIGKILL");
	}

	removePid();
	return true;
}

async function startBackground(port: number): Promise<void> {
	const serverScript = resolveServerScript();
	const tsxPath = resolveTsx();

	const serverEnv: Record<string, string> = {
		PORT: String(port),
		AGENTS_DIR: getAgentsDir(),
		SKILLS_DIR: getSkillsDir(),
		MAXIMUS_VAULT_PATH: getVaultPath(),
		MAXIMUS_VAULT_KEY: process.env.MAXIMUS_VAULT_KEY ?? "",
	};

	const child = spawn("node", [tsxPath, serverScript], {
		env: { ...process.env, ...serverEnv },
		stdio: "ignore",
		detached: true,
	});
	child.unref();
	writePid(child.pid!);
	success(`Server started in background (PID ${child.pid}) on port ${port}`);
}

export function registerServerCommand(parent: Command): void {
	const server = parent
		.command("server")
		.description("Start and stop the Maximus server");

	server
		.command("start")
		.description("Launch the Maximus server")
		.option("-f, --foreground", "Run server in foreground (attached to terminal)")
		.option("-p, --port <number>", "Override configured port")
		.action(async (opts: { foreground?: boolean; port?: string }) => {
			try {
				const config = getConfig();
				const port = opts.port ? parseInt(opts.port, 10) : config.port;

				// Check if already running
				const existingPid = readPid();
				if (existingPid !== null && isProcessRunning(existingPid)) {
					errorMessage(
						`Server already running (PID ${existingPid}). Run \`maximus server stop\` first.`,
					);
					process.exit(1);
				}

				const serverScript = resolveServerScript();
				const tsxPath = resolveTsx();

				const serverEnv: Record<string, string> = {
					PORT: String(port),
					AGENTS_DIR: getAgentsDir(),
					SKILLS_DIR: getSkillsDir(),
					MAXIMUS_VAULT_PATH: getVaultPath(),
					MAXIMUS_VAULT_KEY: process.env.MAXIMUS_VAULT_KEY ?? "",
				};

				if (opts.foreground) {
					info(`Starting Maximus server on port ${port}...`);
					const child = spawn("node", [tsxPath, serverScript], {
						env: { ...process.env, ...serverEnv },
						stdio: "inherit",
					});
					writePid(child.pid!);
					child.on("exit", (code) => {
						removePid();
						process.exit(code ?? 0);
					});
					process.on("SIGINT", () => {
						removePid();
						child.kill("SIGINT");
					});
					process.on("SIGTERM", () => {
						removePid();
						child.kill("SIGTERM");
					});
				} else {
					const child = spawn("node", [tsxPath, serverScript], {
						env: { ...process.env, ...serverEnv },
						stdio: "ignore",
						detached: true,
					});
					child.unref();
					writePid(child.pid!);
					success(
						`Server started in background (PID ${child.pid}) on port ${port}`,
					);
				}
			} catch (err) {
				handleCommandError(err);
			}
		});

	server
		.command("stop")
		.description("Stop the Maximus server")
		.action(async () => {
			try {
				const pid = readPid();

				if (pid === null) {
					errorMessage(
						"Server not running.",
						"maximus server start --background",
					);
					process.exit(1);
				}

				if (!isProcessRunning(pid)) {
					removePid();
					warn(
						"Stale PID file removed. Server was not running.",
					);
					return;
				}

				info(`Stopping server (PID ${pid})...`);
				process.kill(pid, "SIGTERM");

				// Poll up to 5 seconds waiting for process to die
				const deadline = Date.now() + 5000;
				while (Date.now() < deadline) {
					if (!isProcessRunning(pid)) break;
					await new Promise((r) => setTimeout(r, 200));
				}

				// Force kill if still alive
				if (isProcessRunning(pid)) {
					warn("Server did not stop gracefully, sending SIGKILL...");
					process.kill(pid, "SIGKILL");
				}

				removePid();
				success("Server stopped.");
			} catch (err) {
				handleCommandError(err);
			}
		});

	server
		.command("restart")
		.description("Restart the server")
		.option("-p, --port <number>", "Override configured port")
		.addHelpText("after", "\nExample:\n  $ maximus server restart\n  $ maximus server restart --port 8080")
		.action(async (opts: { port?: string }) => {
			try {
				await stopServer();
				const config = getConfig();
				const port = opts.port ? parseInt(opts.port, 10) : config.port;
				await startBackground(port);
			} catch (err) {
				handleCommandError(err);
			}
		});

	server
		.command("status")
		.description("Show server status")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample:\n  $ maximus server status\n  $ maximus server status --json")
		.action(async (opts: { json?: boolean }) => {
			try {
				const config = getConfig();
				const pid = readPid();
				const running = pid !== null && isProcessRunning(pid);

				if (opts.json) {
					if (running) {
						const startTime = statSync(getPidPath()).mtimeMs;
						const uptimeMs = Date.now() - startTime;
						const agentCount = countAgents(getAgentsDir());
						const result = {
							status: "running",
							pid,
							port: config.port,
							uptime: formatUptime(uptimeMs),
							uptimeMs,
							agentCount,
						};
						process.stdout.write(JSON.stringify(result, null, 2) + "\n");
					} else {
						process.stdout.write(JSON.stringify({ status: "stopped" }, null, 2) + "\n");
					}
					return;
				}

				if (running) {
					const startTime = statSync(getPidPath()).mtimeMs;
					const uptimeMs = Date.now() - startTime;
					const agentCount = countAgents(getAgentsDir());
					const table = createTable(["Property", "Value"]);
					table.push(
						["Status", chalk.green("Running")],
						["PID", String(pid)],
						["Port", String(config.port)],
						["Uptime", formatUptime(uptimeMs)],
						["Agents", String(agentCount)],
					);
					console.log(table.toString());
				} else {
					if (pid !== null) removePid();
					const table = createTable(["Property", "Value"]);
					table.push(["Status", chalk.red("Stopped")]);
					console.log(table.toString());
				}
			} catch (err) {
				handleCommandError(err);
			}
		});
}
