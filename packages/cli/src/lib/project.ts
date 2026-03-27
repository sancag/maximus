import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod/v4";

export const configSchema = z.object({
	name: z.string().default("maximus"),
	port: z.number().int().min(1).max(65535).default(4100),
});

export type MaximusConfig = z.infer<typeof configSchema>;

export function getProjectDir(): string {
	return join(homedir(), ".maximus");
}

export function hasProject(): boolean {
	return existsSync(getProjectDir());
}

export function getConfigPath(): string {
	return join(getProjectDir(), "config.json");
}

export function getAgentsDir(): string {
	return join(getProjectDir(), "agents");
}

export function getSkillsDir(): string {
	return join(getProjectDir(), "skills");
}

export function getVaultDir(): string {
	return join(getProjectDir(), "vault");
}

export function getVaultPath(): string {
	return join(getVaultDir(), "store.json");
}

export function getEnvPath(): string {
	return join(getProjectDir(), ".env");
}

export function getPidPath(): string {
	return join(getProjectDir(), "maximus.pid");
}

export function loadProjectEnv(): void {
	const envPath = getEnvPath();
	if (!existsSync(envPath)) return;
	const content = readFileSync(envPath, "utf-8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex);
		const value = trimmed.slice(eqIndex + 1);
		// Don't overwrite existing env vars (explicit env takes precedence)
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

export function getProjectConfig(): MaximusConfig {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) {
		throw new Error("No .maximus/ found. Run `maximus init` first.");
	}
	return configSchema.parse(JSON.parse(readFileSync(configPath, "utf-8")));
}
