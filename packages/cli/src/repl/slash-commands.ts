import { spawn } from "node:child_process";
import { statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { getConfig } from "../lib/config.js";
import {
	getAgentsDir,
	getSkillsDir,
	getVaultPath,
	getProjectDir,
	getPidPath,
	getEnvPath,
} from "../lib/project.js";
import { readPid, writePid, removePid, isProcessRunning } from "../lib/pid.js";
import { formatUptime } from "../commands/server.js";
import { loadVaultFromConfig } from "../lib/vault-helpers.js";
import { success, info, warn, createTable } from "../lib/output.js";

const gold = chalk.hex("#E8A422");
const dimGold = chalk.hex("#C4851A");

export interface SlashCommand {
	name: string;
	description: string;
	handler: (args: string) => Promise<void>;
}

export interface SlashDispatcher {
	register(cmd: SlashCommand): void;
	dispatch(line: string): Promise<boolean>;
	getCommands(): SlashCommand[];
}

export function createSlashDispatcher(): SlashDispatcher {
	const commands = new Map<string, SlashCommand>();

	return {
		register(cmd: SlashCommand) {
			commands.set(cmd.name, cmd);
		},

		async dispatch(line: string): Promise<boolean> {
			if (!line.startsWith("/")) return false;
			const parts = line.slice(1).split(/\s+/);
			const name = parts[0];
			const args = parts.slice(1).join(" ");

			const cmd = commands.get(name);
			if (!cmd) {
				console.log(
					chalk.red(`Unknown command: /${name}`) +
						dimGold("  Type /help for commands."),
				);
				return true; // Handled (as error)
			}

			await cmd.handler(args);
			return true;
		},

		getCommands(): SlashCommand[] {
			return Array.from(commands.values());
		},
	};
}

export interface DefaultCommandCallbacks {
	onExit: () => void;
	onInit: () => Promise<void>;
	onServerStateChange?: (online: boolean) => void;
	pauseInput: () => void;
	resumeInput: () => void;
}

function resolveServerScript(): string {
	const pkgJson = require.resolve("@maximus/server/package.json");
	return path.join(path.dirname(pkgJson), "src", "main.ts");
}

function resolveTsx(): string {
	const pkgJson = require.resolve("tsx/package.json");
	return path.join(path.dirname(pkgJson), "dist", "cli.mjs");
}

export function registerDefaultCommands(
	dispatcher: SlashDispatcher,
	callbacks: DefaultCommandCallbacks,
): void {
	dispatcher.register({
		name: "help",
		description: "Show available commands",
		handler: async () => {
			console.log();
			console.log(gold("  Commands:"));
			console.log();
			for (const cmd of dispatcher.getCommands()) {
				console.log(
					`  ${gold(`/${cmd.name}`.padEnd(16))}${dimGold(cmd.description)}`,
				);
			}
			console.log();
		},
	});

	dispatcher.register({
		name: "exit",
		description: "Exit the REPL",
		handler: async () => {
			callbacks.onExit();
		},
	});

	dispatcher.register({
		name: "init",
		description: "Initialize a new Maximus project",
		handler: async () => {
			try {
				callbacks.pauseInput();
				await callbacks.onInit();
			} catch (err) {
				console.error(
					chalk.red("Init failed:"),
					err instanceof Error ? err.message : String(err),
				);
			} finally {
				callbacks.resumeInput();
			}
		},
	});

	dispatcher.register({
		name: "start",
		description: "Start the server in background",
		handler: async () => {
			try {
				const config = getConfig();
				const existingPid = readPid();
				if (existingPid !== null && isProcessRunning(existingPid)) {
					warn(`Server already running (PID ${existingPid}).`);
					return;
				}

				const serverScript = resolveServerScript();
				const tsxPath = resolveTsx();
				const serverEnv: Record<string, string> = {
					PORT: String(config.port),
					AGENTS_DIR: getAgentsDir(),
					SKILLS_DIR: getSkillsDir(),
					MAXIMUS_VAULT_PATH: getVaultPath(),
					MAXIMUS_VAULT_KEY: process.env.MAXIMUS_VAULT_KEY ?? "",
					MAXIMUS_LOG_FILE: path.join(getProjectDir(), "server.log"),
				};

				const child = spawn("node", [tsxPath, serverScript], {
					env: { ...process.env, ...serverEnv },
					stdio: "ignore",
					detached: true,
				});
				child.unref();
				writePid(child.pid!);
				success(
					`Server started (PID ${child.pid}) on port ${config.port}`,
				);
				callbacks.onServerStateChange?.(true);
			} catch (err) {
				console.error(
					chalk.red("Start failed:"),
					err instanceof Error ? err.message : String(err),
				);
			}
		},
	});

	dispatcher.register({
		name: "stop",
		description: "Stop the background server",
		handler: async () => {
			try {
				const pid = readPid();
				if (pid === null) {
					warn("Server not running.");
					return;
				}

				if (!isProcessRunning(pid)) {
					removePid();
					warn("Stale PID file removed. Server was not running.");
					return;
				}

				info(`Stopping server (PID ${pid})...`);
				process.kill(pid, "SIGTERM");

				const deadline = Date.now() + 5000;
				while (Date.now() < deadline) {
					if (!isProcessRunning(pid)) break;
					await new Promise((r) => setTimeout(r, 200));
				}

				if (isProcessRunning(pid)) {
					warn(
						"Server did not stop gracefully, sending SIGKILL...",
					);
					process.kill(pid, "SIGKILL");
				}

				removePid();
				success("Server stopped.");
				callbacks.onServerStateChange?.(false);
			} catch (err) {
				console.error(
					chalk.red("Stop failed:"),
					err instanceof Error ? err.message : String(err),
				);
			}
		},
	});

	dispatcher.register({
		name: "restart",
		description: "Restart the server",
		handler: async () => {
			try {
				// Stop first
				const pid = readPid();
				if (pid !== null && isProcessRunning(pid)) {
					info(`Stopping server (PID ${pid})...`);
					process.kill(pid, "SIGTERM");
					const deadline = Date.now() + 5000;
					while (Date.now() < deadline) {
						if (!isProcessRunning(pid)) break;
						await new Promise((r) => setTimeout(r, 200));
					}
					if (isProcessRunning(pid)) {
						process.kill(pid, "SIGKILL");
					}
					removePid();
				}

				// Start
				const config = getConfig();
				const serverScript = resolveServerScript();
				const tsxPath = resolveTsx();
				const serverEnv: Record<string, string> = {
					PORT: String(config.port),
					AGENTS_DIR: getAgentsDir(),
					SKILLS_DIR: getSkillsDir(),
					MAXIMUS_VAULT_PATH: getVaultPath(),
					MAXIMUS_VAULT_KEY: process.env.MAXIMUS_VAULT_KEY ?? "",
					MAXIMUS_LOG_FILE: path.join(getProjectDir(), "server.log"),
				};

				const child = spawn("node", [tsxPath, serverScript], {
					env: { ...process.env, ...serverEnv },
					stdio: "ignore",
					detached: true,
				});
				child.unref();
				writePid(child.pid!);
				success(
					`Server restarted (PID ${child.pid}) on port ${config.port}`,
				);
				callbacks.onServerStateChange?.(true);
			} catch (err) {
				console.error(
					chalk.red("Restart failed:"),
					err instanceof Error ? err.message : String(err),
				);
			}
		},
	});

	dispatcher.register({
		name: "status",
		description: "Show server status",
		handler: async () => {
			try {
				const config = getConfig();
				const pid = readPid();
				const running = pid !== null && isProcessRunning(pid);

				if (running) {
					const startTime = statSync(getPidPath()).mtimeMs;
					const uptimeMs = Date.now() - startTime;
					const table = createTable(["Property", "Value"]);
					table.push(
						["Status", chalk.green("Running")],
						["PID", String(pid)],
						["Port", String(config.port)],
						["Uptime", formatUptime(uptimeMs)],
					);
					console.log(table.toString());
				} else {
					if (pid !== null) removePid();
					info("Server is not running.");
				}
			} catch (err) {
				console.error(
					chalk.red("Status check failed:"),
					err instanceof Error ? err.message : String(err),
				);
			}
		},
	});

	dispatcher.register({
		name: "vault",
		description: "Manage credentials (set/get/list/delete)",
		handler: async (args: string) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "";
			const name = parts[1] || "";

			try {
				if (sub === "set") {
					if (!name) {
						console.error(
							chalk.red("Usage: /vault set <name>"),
						);
						return;
					}
					callbacks.pauseInput();
					try {
						const { password, input } = await import(
							"@inquirer/prompts"
						);
						const value = await password({ message: "Value:" });
						if (!value) {
							warn("Value cannot be empty.");
							return;
						}
						const desc = await input({
							message: "Description (optional):",
							default: "",
						});
						const { vault: v, vaultPath } =
							await loadVaultFromConfig();
						v.set(
							name,
							value,
							desc ? { description: desc } : undefined,
						);
						v.save(vaultPath);
						success(`Credential "${name}" saved.`);
					} finally {
						callbacks.resumeInput();
					}
				} else if (sub === "get") {
					if (!name) {
						console.error(
							chalk.red("Usage: /vault get <name>"),
						);
						return;
					}
					const { vault: v } = await loadVaultFromConfig();
					console.log(v.get(name));
				} else if (sub === "list") {
					const { vault: v } = await loadVaultFromConfig();
					const creds = v.list();
					if (creds.length === 0) {
						warn("No credentials stored.");
						return;
					}
					const table = createTable([
						"Name",
						"Description",
						"Created",
						"Updated",
					]);
					for (const c of creds) {
						table.push([
							c.name,
							c.description ?? "",
							new Date(c.createdAt).toLocaleDateString(),
							new Date(c.updatedAt).toLocaleDateString(),
						]);
					}
					console.log(table.toString());
				} else if (sub === "delete") {
					if (!name) {
						console.error(
							chalk.red("Usage: /vault delete <name>"),
						);
						return;
					}
					callbacks.pauseInput();
					try {
						const { confirm } = await import("@inquirer/prompts");
						const { vault: v, vaultPath } =
							await loadVaultFromConfig();
						if (!v.has(name)) {
							warn(`Credential "${name}" not found.`);
							return;
						}
						const yes = await confirm({
							message: `Delete credential "${name}"?`,
							default: false,
						});
						if (!yes) {
							warn("Delete cancelled.");
							return;
						}
						v.delete(name);
						v.save(vaultPath);
						success(`Credential "${name}" deleted.`);
					} finally {
						callbacks.resumeInput();
					}
				} else {
					console.log(dimGold("Usage: /vault <set|get|list|delete> [name]"));
				}
			} catch (err) {
				console.error(
					chalk.red("Vault error:"),
					err instanceof Error ? err.message : String(err),
				);
			}
		},
	});

	dispatcher.register({
		name: "login",
		description: "Set OAuth token for Claude Code",
		handler: async () => {
			callbacks.pauseInput();
			try {
				const { password } = await import("@inquirer/prompts");
				const token = await password({ message: "OAuth token:" });
				if (!token) {
					warn("Token cannot be empty.");
					return;
				}

				const envPath = getEnvPath();
				let envContent = "";
				if (existsSync(envPath)) {
					envContent = readFileSync(envPath, "utf-8");
				}

				// Update or add the CLAUDE_CODE_OAUTH_TOKEN line
				if (envContent.includes("CLAUDE_CODE_OAUTH_TOKEN=")) {
					envContent = envContent.replace(
						/CLAUDE_CODE_OAUTH_TOKEN=.*/,
						`CLAUDE_CODE_OAUTH_TOKEN=${token}`,
					);
				} else {
					envContent += `\nCLAUDE_CODE_OAUTH_TOKEN=${token}\n`;
				}

				writeFileSync(envPath, envContent);
				success("OAuth token saved to .maximus/.env");
			} catch (err) {
				console.error(
					chalk.red("Login failed:"),
					err instanceof Error ? err.message : String(err),
				);
			} finally {
				callbacks.resumeInput();
			}
		},
	});

	dispatcher.register({
		name: "new",
		description: "Start a new chat session",
		handler: async () => {
			try {
				const config = getConfig();
				const { request } = await import("node:http");
				await new Promise<void>((resolve, reject) => {
					const req = request(
						{
							hostname: "127.0.0.1",
							port: config.port,
							path: "/api/chat/new",
							method: "POST",
						},
						(res) => {
							res.resume();
							res.on("end", () => resolve());
						},
					);
					req.on("error", reject);
					req.end();
				});
				success("New session started.");
			} catch {
				warn("Server not running. Start with /start first.");
			}
		},
	});
}
