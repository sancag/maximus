import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { password } from "@inquirer/prompts";
import { CredentialVault } from "@maximus/vault";
import { getVaultPath as getVaultFilePath } from "./config.js";

export async function getVaultKey(): Promise<string> {
	// Check env var first (for scripting / CI)
	const envKey = process.env.MAXIMUS_VAULT_KEY;
	if (envKey) return envKey;

	// Prompt for key interactively
	return password({ message: "Vault key:" });
}

export async function loadVaultFromConfig(): Promise<{
	vault: CredentialVault;
	vaultPath: string;
}> {
	const vaultPath = getVaultFilePath();
	const key = await getVaultKey();

	// Ensure vault directory exists
	mkdirSync(dirname(vaultPath), { recursive: true });

	if (existsSync(vaultPath)) {
		return { vault: CredentialVault.load(vaultPath, key), vaultPath };
	}
	// Create new vault if store doesn't exist yet
	return { vault: new CredentialVault(key), vaultPath };
}
