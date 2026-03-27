// @deprecated — Use tui/index.tsx (startTui) instead. Kept for backward compatibility.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, dirname } from "node:path";
import chalk from "chalk";
import { hasProject, getProjectConfig, getPidPath, getAgentsDir, getSkillsDir, getVaultPath } from "../lib/project.js";
import { readPid, isProcessRunning, writePid } from "../lib/pid.js";
import { apiGet } from "../lib/api-client.js";
import { formatUptime } from "../commands/server.js";
import { printHeader } from "../lib/output.js";
import { createSlashDispatcher, registerDefaultCommands } from "./slash-commands.js";
import { startInputLoop } from "./input-loop.js";
import { StatusFooter, type StatusState } from "./status-footer.js";
import { StatusWebSocket } from "./ws-client.js";
import { renderStream } from "./stream-renderer.js";

const VERSION = "0.1.0";
const dimGold = chalk.hex("#C4851A");
const darkGold = chalk.hex("#8B6914");

async function ensureServerRunning(
	footer: StatusFooter,
	state: StatusState,
): Promise<boolean> {
	const pid = readPid();
	if (pid !== null && isProcessRunning(pid)) return true;

	// Auto-start server in background
	console.log(dimGold("  Starting server..."));

	try {
		const pkgJson = require.resolve("@maximus/server/package.json");
		const serverScript = join(dirname(pkgJson), "src", "main.ts");
		const tsxPkgJson = require.resolve("tsx/package.json");
		const tsxPath = join(dirname(tsxPkgJson), "dist", "cli.mjs");
		const config = getProjectConfig();

		const serverEnv: Record<string, string> = {
			PORT: String(config.port),
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

		// Wait for server to be ready (poll /api/health up to 15 seconds)
		for (let i = 0; i < 30; i++) {
			try {
				await apiGet("/api/health");
				state.serverOnline = true;
				footer.update(state);
				return true;
			} catch {
				await new Promise((r) => setTimeout(r, 500));
			}
		}

		console.error(chalk.red("Server failed to start within 15 seconds."));
		return false;
	} catch (err) {
		console.error(
			chalk.red("Failed to start server:"),
			err instanceof Error ? err.message : String(err),
		);
		return false;
	}
}

export async function startRepl(): Promise<void> {
	const projectExists = hasProject();

	// Print banner
	printHeader();
	console.log(`  ${dimGold("agent orchestration platform")}`);
	console.log(`  ${darkGold(`v${VERSION}`)}`);
	console.log();

	// Initialize status state
	const state: StatusState = {
		serverOnline: false,
		agentCount: 0,
		taskCount: 0,
		uptime: "0s",
		projectInitialized: projectExists,
	};

	// Check server status if project exists
	if (projectExists) {
		const pid = readPid();
		if (pid !== null && isProcessRunning(pid)) {
			state.serverOnline = true;
			try {
				const startTime = statSync(getPidPath()).mtimeMs;
				state.uptime = formatUptime(Date.now() - startTime);
				const data = await apiGet<{ agents: Array<unknown> }>(
					"/api/agents",
				).catch(() => ({ agents: [] }));
				state.agentCount = data.agents?.length ?? 0;
			} catch {
				/* ignore */
			}
		}
	}

	// Set up status footer
	const footer = new StatusFooter();
	footer.setup();
	footer.update(state);

	// Set up WebSocket client for live updates
	let wsClient: StatusWebSocket | null = null;
	if (projectExists && state.serverOnline) {
		const config = getProjectConfig();
		wsClient = new StatusWebSocket((partial) => {
			Object.assign(state, partial);
			footer.update(state);
		});
		wsClient.connect(config.port);
	}

	// Set up slash dispatcher
	const dispatcher = createSlashDispatcher();
	let loopControls: ReturnType<typeof startInputLoop> | null = null;

	registerDefaultCommands(dispatcher, {
		onExit: () => {
			console.log(dimGold("Goodbye."));
			loopControls?.rl.close();
		},
		onInit: async () => {
			const { runInitWizard } = await import("../commands/init.js");
			await runInitWizard();
			// After init, update state
			if (hasProject()) {
				state.projectInitialized = true;
				footer.update(state);
			}
		},
		pauseInput: () => loopControls?.pause(),
		resumeInput: () => loopControls?.resume(),
	});

	// Chat handler with auto-start
	const handleChat = async (message: string): Promise<void> => {
		if (!hasProject()) {
			console.log(
				chalk.yellow("No agents configured. Run /init first."),
			);
			return;
		}

		// Auto-start server if needed (AUTO-01)
		const running = await ensureServerRunning(footer, state);
		if (!running) return;

		// Connect WS if not connected
		if (!wsClient && state.serverOnline) {
			const config = getProjectConfig();
			wsClient = new StatusWebSocket((partial) => {
				Object.assign(state, partial);
				footer.update(state);
			});
			wsClient.connect(config.port);
		}

		await renderStream(message, {
			onComplete: () => {
				state.activeAgent = undefined;
				footer.update(state);
			},
		});
	};

	// Start input loop
	loopControls = startInputLoop({
		onChat: handleChat,
		dispatcher,
		onClose: () => {
			// Clean up (AUTO-02: leave server running)
			footer.destroy();
			wsClient?.destroy();
			process.exit(0);
		},
	});

	loopControls.rl.prompt();
}
