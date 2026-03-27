// Re-export project-local config (replaces global ~/.maximus/)
export {
	configSchema,
	type MaximusConfig,
	getProjectDir,
	hasProject,
	getConfigPath,
	getAgentsDir,
	getSkillsDir,
	getVaultDir,
	getVaultPath,
	getEnvPath,
	getPidPath,
	getProjectConfig as getConfig,
} from "./project.js";

// Legacy exports for migration period (deprecated)
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";

/** @deprecated Use getProjectDir() */
export const MAXIMUS_HOME = join(homedir(), ".maximus");
/** @deprecated Use getConfigPath() */
export const CONFIG_PATH = join(MAXIMUS_HOME, "config.json");

/** @deprecated Init now writes to .maximus/config.json */
export function writeConfig(config: Record<string, unknown>): void {
	mkdirSync(MAXIMUS_HOME, { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** @deprecated Use getProjectDir() */
export function ensureMaximusHome(): void {
	mkdirSync(MAXIMUS_HOME, { recursive: true });
}
