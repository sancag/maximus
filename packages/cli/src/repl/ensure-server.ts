import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { getProjectConfig, getProjectDir, getAgentsDir, getSkillsDir, getVaultPath } from "../lib/project.js";
import { readPid, isProcessRunning, writePid } from "../lib/pid.js";
import { apiGet } from "../lib/api-client.js";
import type { StatusState } from "./status-footer.js";

/**
 * Ensure the Maximus server is running.
 * If not running, auto-starts it in the background and polls /api/health.
 *
 * @param onStatusChange - callback invoked when server status changes
 * @returns true if server is running (or was started), false on failure
 */
export async function ensureServerRunning(
	onStatusChange: (partial: Partial<StatusState>) => void,
): Promise<boolean> {
	const pid = readPid();
	if (pid !== null && isProcessRunning(pid)) return true;

	// Auto-start server in background
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
			MAXIMUS_LOG_FILE: join(getProjectDir(), "server.log"),
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
				onStatusChange({ serverOnline: true });
				return true;
			} catch {
				await new Promise((r) => setTimeout(r, 500));
			}
		}

		return false;
	} catch {
		return false;
	}
}
