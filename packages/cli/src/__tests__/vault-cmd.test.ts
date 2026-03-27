import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CredentialVault } from "@maximus/vault";

// Mock @inquirer/prompts before importing modules that use it
vi.mock("@inquirer/prompts", () => ({
	password: vi.fn(),
	input: vi.fn(),
	confirm: vi.fn(),
}));

// Mock config to point at temp directories
vi.mock("../lib/config.js", () => ({
	getConfig: vi.fn(),
	getVaultPath: vi.fn(),
}));

import { password, input, confirm } from "@inquirer/prompts";
import { getConfig, getVaultPath } from "../lib/config.js";
import { getVaultKey, loadVaultFromConfig } from "../lib/vault-helpers.js";

const TEST_KEY = "test-vault-key-12345";
const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-vault-test-"));
	tempDirs.push(dir);
	return dir;
}

function setupConfig(vaultPathArg: string) {
	vi.mocked(getConfig).mockReturnValue({
		name: "maximus",
		port: 4100,
	});
	vi.mocked(getVaultPath).mockReturnValue(vaultPathArg);
}

/** Pre-populate a vault file with credentials */
function seedVault(
	vaultPath: string,
	creds: Array<{ name: string; value: string; description?: string }>,
): void {
	const vault = new CredentialVault(TEST_KEY);
	for (const c of creds) {
		vault.set(c.name, c.value, c.description ? { description: c.description } : undefined);
	}
	vault.save(vaultPath);
}

describe("Vault CLI commands", () => {
	let tempDir: string;
	let vaultPath: string;

	beforeEach(() => {
		tempDir = createTempDir();
		vaultPath = path.join(tempDir, "store.json");
		setupConfig(vaultPath);
		// Default: use env var for vault key
		process.env.MAXIMUS_VAULT_KEY = TEST_KEY;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.MAXIMUS_VAULT_KEY;
		for (const dir of tempDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	describe("getVaultKey", () => {
		it("uses MAXIMUS_VAULT_KEY env var when set", async () => {
			process.env.MAXIMUS_VAULT_KEY = "env-key-value";
			const key = await getVaultKey();
			expect(key).toBe("env-key-value");
			expect(password).not.toHaveBeenCalled();
		});

		it("prompts when env var not set", async () => {
			delete process.env.MAXIMUS_VAULT_KEY;
			vi.mocked(password).mockResolvedValue("prompted-key");
			const key = await getVaultKey();
			expect(key).toBe("prompted-key");
			expect(password).toHaveBeenCalledWith({ message: "Vault key:" });
		});
	});

	describe("vault set", () => {
		it("stores a credential with masked input", async () => {
			vi.mocked(password).mockResolvedValueOnce("my-secret");
			vi.mocked(input).mockResolvedValueOnce("API key");

			// Import vault command and invoke set action directly
			const { registerVaultCommand } = await import("../commands/vault.js");
			const { Command } = await import("commander");
			const program = new Command();
			program.exitOverride();
			registerVaultCommand(program);

			// Parse the set command
			await program.parseAsync(["node", "maximus", "vault", "set", "MY_TOKEN"]);

			// Verify vault store was created and credential is readable
			expect(fs.existsSync(vaultPath)).toBe(true);
			const loaded = CredentialVault.load(vaultPath, TEST_KEY);
			expect(loaded.get("MY_TOKEN")).toBe("my-secret");
			const meta = loaded.list().find((c) => c.name === "MY_TOKEN");
			expect(meta?.description).toBe("API key");
		});
	});

	describe("vault get", () => {
		it("outputs raw value to stdout with no decoration", async () => {
			seedVault(vaultPath, [{ name: "SECRET", value: "raw-value-123" }]);

			const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			const { registerVaultCommand } = await import("../commands/vault.js");
			const { Command } = await import("commander");
			const program = new Command();
			program.exitOverride();
			registerVaultCommand(program);

			await program.parseAsync(["node", "maximus", "vault", "get", "SECRET"]);

			// Find the call that wrote our value
			const calls = writeSpy.mock.calls.map((c) => String(c[0]));
			expect(calls).toContain("raw-value-123");
			// Verify no ANSI codes around the value
			const valueCall = calls.find((c) => c.includes("raw-value-123"));
			expect(valueCall).toBe("raw-value-123");
		});
	});

	describe("vault list", () => {
		it("shows metadata table with credential names", async () => {
			seedVault(vaultPath, [
				{ name: "TOKEN_A", value: "val-a", description: "First token" },
				{ name: "TOKEN_B", value: "val-b", description: "Second token" },
			]);

			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const { registerVaultCommand } = await import("../commands/vault.js");
			const { Command } = await import("commander");
			const program = new Command();
			program.exitOverride();
			registerVaultCommand(program);

			await program.parseAsync(["node", "maximus", "vault", "list"]);

			const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(output).toContain("TOKEN_A");
			expect(output).toContain("TOKEN_B");
			expect(output).toContain("First token");
			// Values should NOT appear in list output
			expect(output).not.toContain("val-a");
			expect(output).not.toContain("val-b");
		});

		it("outputs JSON with --json flag", async () => {
			seedVault(vaultPath, [
				{ name: "TOKEN_A", value: "val-a", description: "First token" },
			]);

			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const { registerVaultCommand } = await import("../commands/vault.js");
			const { Command } = await import("commander");
			const program = new Command();
			program.exitOverride();
			registerVaultCommand(program);

			await program.parseAsync(["node", "maximus", "vault", "list", "--json"]);

			const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
			const parsed = JSON.parse(output);
			expect(parsed).toBeInstanceOf(Array);
			expect(parsed[0].name).toBe("TOKEN_A");
			expect(parsed[0].description).toBe("First token");
		});
	});

	describe("vault delete", () => {
		it("removes credential after confirmation", async () => {
			seedVault(vaultPath, [{ name: "TO_DELETE", value: "val" }]);
			vi.mocked(confirm).mockResolvedValueOnce(true);

			const { registerVaultCommand } = await import("../commands/vault.js");
			const { Command } = await import("commander");
			const program = new Command();
			program.exitOverride();
			registerVaultCommand(program);

			await program.parseAsync(["node", "maximus", "vault", "delete", "TO_DELETE"]);

			// Reload and verify deleted
			const loaded = CredentialVault.load(vaultPath, TEST_KEY);
			expect(loaded.has("TO_DELETE")).toBe(false);
		});

		it("keeps credential when confirmation is declined", async () => {
			seedVault(vaultPath, [{ name: "KEEP_ME", value: "val" }]);
			vi.mocked(confirm).mockResolvedValueOnce(false);

			const { registerVaultCommand } = await import("../commands/vault.js");
			const { Command } = await import("commander");
			const program = new Command();
			program.exitOverride();
			registerVaultCommand(program);

			await program.parseAsync(["node", "maximus", "vault", "delete", "KEEP_ME"]);

			// Credential should still exist (file unchanged)
			const loaded = CredentialVault.load(vaultPath, TEST_KEY);
			expect(loaded.has("KEEP_ME")).toBe(true);
		});
	});

	describe("vault get nonexistent", () => {
		it("exits with error for missing credential", async () => {
			seedVault(vaultPath, [{ name: "EXISTS", value: "val" }]);

			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

			const { registerVaultCommand } = await import("../commands/vault.js");
			const { Command } = await import("commander");
			const program = new Command();
			program.exitOverride();
			registerVaultCommand(program);

			await program.parseAsync(["node", "maximus", "vault", "get", "MISSING"]);

			expect(exitSpy).toHaveBeenCalledWith(1);
			const allOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
			expect(allOutput).toContain("Credential not found");
		});
	});
});
