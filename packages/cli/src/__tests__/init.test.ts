import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	existsSync,
	readFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import matter from "gray-matter";

// ---- Mocks ----

vi.mock("@inquirer/prompts", () => ({
	input: vi.fn(),
	password: vi.fn(),
}));

// Mock project.ts to redirect all paths to temp dir
const projectState = { tmpDir: "" };

vi.mock("../lib/project.js", () => ({
	getProjectDir: () => join(projectState.tmpDir, ".maximus"),
	hasProject: () => existsSync(join(projectState.tmpDir, ".maximus")),
	getConfigPath: () => join(projectState.tmpDir, ".maximus", "config.json"),
	getAgentsDir: () => join(projectState.tmpDir, ".maximus", "agents"),
	getSkillsDir: () => join(projectState.tmpDir, ".maximus", "skills"),
	getVaultDir: () => join(projectState.tmpDir, ".maximus", "vault"),
	getVaultPath: () => join(projectState.tmpDir, ".maximus", "vault", "store.json"),
	getEnvPath: () => join(projectState.tmpDir, ".maximus", ".env"),
	getPidPath: () => join(projectState.tmpDir, ".maximus", "maximus.pid"),
	getProjectConfig: () => {
		const configPath = join(projectState.tmpDir, ".maximus", "config.json");
		if (!existsSync(configPath)) throw new Error("No .maximus/ found.");
		return JSON.parse(readFileSync(configPath, "utf-8"));
	},
	configSchema: {},
}));

import { input, password } from "@inquirer/prompts";
import { registerInitCommand } from "../commands/init.js";
import { Command } from "commander";

const mockedInput = vi.mocked(input);
const mockedPassword = vi.mocked(password);

async function runInit(): Promise<void> {
	const program = new Command();
	program.exitOverride();
	registerInitCommand(program);
	await program.parseAsync(["node", "maximus", "init"]);
}

describe("maximus init", () => {
	let tmpDir: string;
	let savedToken: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "maximus-init-test-"));
		projectState.tmpDir = tmpDir;

		vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
		vi.spyOn(console, "log").mockImplementation(() => {});

		savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		rmSync(tmpDir, { recursive: true, force: true });
		if (savedToken !== undefined) {
			process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
		} else {
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		}
	});

	it("creates .maximus/ structure with agent", async () => {
		mockedInput.mockResolvedValueOnce("myagent");
		mockedPassword.mockResolvedValueOnce("test-token");
		mockedPassword.mockResolvedValueOnce("test-vault-key");

		await runInit();

		expect(existsSync(join(tmpDir, ".maximus", "config.json"))).toBe(true);
		expect(existsSync(join(tmpDir, ".maximus", "identity.md"))).toBe(true);
		expect(existsSync(join(tmpDir, ".maximus", "agents", "myagent.md"))).toBe(true);
		expect(existsSync(join(tmpDir, ".maximus", "docs", "agents.md"))).toBe(true);
		expect(existsSync(join(tmpDir, ".maximus", "docs", "skills.md"))).toBe(true);
		expect(existsSync(join(tmpDir, ".maximus", "docs", "vault.md"))).toBe(true);
		expect(existsSync(join(tmpDir, ".maximus", "memory"))).toBe(true);
		expect(existsSync(join(tmpDir, ".maximus", "vault"))).toBe(true);
		expect(existsSync(join(tmpDir, ".maximus", ".env"))).toBe(true);
		expect(existsSync(join(tmpDir, ".maximus", ".gitignore"))).toBe(true);
	});

	it("config.json has agent name and port", async () => {
		mockedInput.mockResolvedValueOnce("myagent");
		mockedPassword.mockResolvedValueOnce("test-token");
		mockedPassword.mockResolvedValueOnce("test-vault-key");

		await runInit();

		const config = JSON.parse(
			readFileSync(join(tmpDir, ".maximus", "config.json"), "utf-8"),
		);
		expect(config.name).toBe("myagent");
		expect(config.port).toBe(4100);
	});

	it("orchestrator agent has correct name in frontmatter", async () => {
		mockedInput.mockResolvedValueOnce("atlas");
		mockedPassword.mockResolvedValueOnce("test-token");
		mockedPassword.mockResolvedValueOnce("test-vault-key");

		await runInit();

		const content = readFileSync(
			join(tmpDir, ".maximus", "agents", "atlas.md"),
			"utf-8",
		);
		const { data } = matter(content);
		expect(data.name).toBe("atlas");
	});

	it(".gitignore contains vault/", async () => {
		mockedInput.mockResolvedValueOnce("myagent");
		mockedPassword.mockResolvedValueOnce("test-token");
		mockedPassword.mockResolvedValueOnce("test-vault-key");

		await runInit();

		const gitignore = readFileSync(
			join(tmpDir, ".maximus", ".gitignore"),
			"utf-8",
		);
		expect(gitignore).toContain("vault/");
	});

	it(".env contains token and vault key", async () => {
		mockedInput.mockResolvedValueOnce("myagent");
		mockedPassword.mockResolvedValueOnce("my-oauth-token");
		mockedPassword.mockResolvedValueOnce("my-vault-key");

		await runInit();

		const envContent = readFileSync(
			join(tmpDir, ".maximus", ".env"),
			"utf-8",
		);
		expect(envContent).toContain("CLAUDE_CODE_OAUTH_TOKEN=my-oauth-token");
		expect(envContent).toContain("MAXIMUS_VAULT_KEY=my-vault-key");
	});

	it("skips init when project exists", async () => {
		mkdirSync(join(tmpDir, ".maximus"), { recursive: true });

		await runInit();

		// password should not be called if init is skipped
		expect(mockedPassword).not.toHaveBeenCalled();
		// No additional files should be created
		expect(existsSync(join(tmpDir, ".maximus", "config.json"))).toBe(false);
	});

	it("uses CLAUDE_CODE_OAUTH_TOKEN from env when available", async () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token-value";

		mockedInput.mockResolvedValueOnce("myagent");
		mockedPassword.mockResolvedValueOnce("test-vault-key");

		await runInit();

		// password should only be called once (for vault key, not token)
		expect(mockedPassword).toHaveBeenCalledTimes(1);
		expect(mockedPassword).toHaveBeenCalledWith({ message: "Vault encryption key:" });

		const envContent = readFileSync(
			join(tmpDir, ".maximus", ".env"),
			"utf-8",
		);
		expect(envContent).toContain("CLAUDE_CODE_OAUTH_TOKEN=env-token-value");
	});
});
