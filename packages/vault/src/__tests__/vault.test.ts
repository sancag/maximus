import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CredentialVault } from "../vault.js";
import { CredentialProxy } from "../proxy.js";

describe("CredentialVault", () => {
	const TEST_KEY = "test-vault-key-for-encryption";
	let tempDir: string;
	const tempDirs: string[] = [];

	function createTempDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of tempDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	it("creates a vault instance in memory", () => {
		const vault = new CredentialVault(TEST_KEY);
		expect(vault).toBeInstanceOf(CredentialVault);
	});

	it("stores and retrieves a credential", () => {
		const vault = new CredentialVault(TEST_KEY);
		vault.set("github_token", "ghp_abc123", { description: "GitHub PAT" });
		const result = vault.get("github_token");
		expect(result).toBe("ghp_abc123");
	});

	it("throws when getting a nonexistent credential", () => {
		const vault = new CredentialVault(TEST_KEY);
		expect(() => vault.get("nonexistent")).toThrow(
			"Credential not found: nonexistent",
		);
	});

	it("has() returns true for existing and false for missing credentials", () => {
		const vault = new CredentialVault(TEST_KEY);
		vault.set("github_token", "ghp_abc123");
		expect(vault.has("github_token")).toBe(true);
		expect(vault.has("missing")).toBe(false);
	});

	it("delete() removes a credential", () => {
		const vault = new CredentialVault(TEST_KEY);
		vault.set("github_token", "ghp_abc123");
		const deleted = vault.delete("github_token");
		expect(deleted).toBe(true);
		expect(() => vault.get("github_token")).toThrow(
			"Credential not found: github_token",
		);
	});

	it("delete() returns false for nonexistent credential", () => {
		const vault = new CredentialVault(TEST_KEY);
		expect(vault.delete("nonexistent")).toBe(false);
	});

	it("list() returns metadata without secrets", () => {
		const vault = new CredentialVault(TEST_KEY);
		vault.set("github_token", "ghp_abc123", { description: "GitHub PAT" });
		vault.set("aws_key", "AKIAIOSFODNN7EXAMPLE");
		const list = vault.list();
		expect(list).toHaveLength(2);
		const github = list.find((c) => c.name === "github_token");
		expect(github).toBeDefined();
		expect(github!.description).toBe("GitHub PAT");
		expect(github!.createdAt).toBeDefined();
		expect(github!.updatedAt).toBeDefined();
		// Verify no secret values in metadata
		const serialized = JSON.stringify(list);
		expect(serialized).not.toContain("ghp_abc123");
		expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});

	it("save() and load() persist and restore credentials", () => {
		const dir = createTempDir();
		const filepath = path.join(dir, "vault.json");

		const vault1 = new CredentialVault(TEST_KEY);
		vault1.set("github_token", "ghp_abc123", { description: "GitHub PAT" });
		vault1.save(filepath);

		expect(fs.existsSync(filepath)).toBe(true);

		const vault2 = CredentialVault.load(filepath, TEST_KEY);
		expect(vault2.get("github_token")).toBe("ghp_abc123");
	});

	it("save/load cycle preserves multiple credentials", () => {
		const dir = createTempDir();
		const filepath = path.join(dir, "vault.json");

		const vault1 = new CredentialVault(TEST_KEY);
		vault1.set("token1", "value1");
		vault1.set("token2", "value2");
		vault1.set("token3", "value3");
		vault1.save(filepath);

		const vault2 = CredentialVault.load(filepath, TEST_KEY);
		expect(vault2.get("token1")).toBe("value1");
		expect(vault2.get("token2")).toBe("value2");
		expect(vault2.get("token3")).toBe("value3");
	});

	it("wrong key cannot decrypt credentials from another vault", () => {
		const dir = createTempDir();
		const filepath = path.join(dir, "vault.json");

		const vault1 = new CredentialVault("correct-key");
		vault1.set("secret", "my-secret-value");
		vault1.save(filepath);

		const vault2 = CredentialVault.load(filepath, "wrong-key");
		expect(() => vault2.get("secret")).toThrow();
	});

	it("encrypted data on disk does not contain plaintext values", () => {
		const dir = createTempDir();
		const filepath = path.join(dir, "vault.json");

		const vault = new CredentialVault(TEST_KEY);
		vault.set("api_key", "super-secret-api-key-12345");
		vault.save(filepath);

		const fileContents = fs.readFileSync(filepath, "utf-8");
		expect(fileContents).not.toContain("super-secret-api-key-12345");
	});
});

describe("CredentialProxy", () => {
	const TEST_KEY = "test-vault-key-for-proxy";

	it("resolve() returns the decrypted value from the vault", async () => {
		const vault = new CredentialVault(TEST_KEY);
		vault.set("github_token", "ghp_abc123");
		const proxy = new CredentialProxy(vault);
		const value = await proxy.resolve("github_token");
		expect(value).toBe("ghp_abc123");
	});

	it("resolveRefs() maps credential refs to inject_as keys", async () => {
		const vault = new CredentialVault(TEST_KEY);
		vault.set("github_token", "ghp_abc123");
		vault.set("api_key", "sk-test123");
		const proxy = new CredentialProxy(vault);
		const result = await proxy.resolveRefs([
			{ ref: "github_token", inject_as: "TOKEN" },
			{ ref: "api_key", inject_as: "API_KEY" },
		]);
		expect(result).toEqual({
			TOKEN: "ghp_abc123",
			API_KEY: "sk-test123",
		});
	});

	it("resolve() throws for nonexistent credential", async () => {
		const vault = new CredentialVault(TEST_KEY);
		const proxy = new CredentialProxy(vault);
		await expect(proxy.resolve("missing")).rejects.toThrow(
			"Credential not found: missing",
		);
	});
});
