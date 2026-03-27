import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: vi.fn() };
});

describe("loadProjectEnv", () => {
	let tmpDir: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "maximus-env-test-"));
		const os = await import("node:os");
		vi.mocked(os.homedir).mockReturnValue(tmpDir);
	});

	afterEach(() => {
		vi.resetModules();
		for (const key of Object.keys(savedEnv)) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function saveEnv(...keys: string[]) {
		for (const key of keys) {
			savedEnv[key] = process.env[key];
		}
	}

	it("reads KEY=VALUE lines from .maximus/.env into process.env", async () => {
		mkdirSync(join(tmpDir, ".maximus"));
		writeFileSync(
			join(tmpDir, ".maximus", ".env"),
			"MAXIMUS_VAULT_KEY=my-secret-key\nCLAUDE_CODE_OAUTH_TOKEN=tok-123\n",
		);
		saveEnv("MAXIMUS_VAULT_KEY", "CLAUDE_CODE_OAUTH_TOKEN");
		delete process.env.MAXIMUS_VAULT_KEY;
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

		const { loadProjectEnv } = await import("../lib/project.js");
		loadProjectEnv();

		expect(process.env.MAXIMUS_VAULT_KEY).toBe("my-secret-key");
		expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-123");
	});

	it("handles missing .maximus/.env gracefully (no throw)", async () => {
		mkdirSync(join(tmpDir, ".maximus"));
		const { loadProjectEnv } = await import("../lib/project.js");
		expect(() => loadProjectEnv()).not.toThrow();
	});

	it("handles missing .maximus/ directory gracefully (no throw)", async () => {
		const { loadProjectEnv } = await import("../lib/project.js");
		expect(() => loadProjectEnv()).not.toThrow();
	});

	it("does NOT overwrite existing process.env values", async () => {
		mkdirSync(join(tmpDir, ".maximus"));
		writeFileSync(
			join(tmpDir, ".maximus", ".env"),
			"MAXIMUS_VAULT_KEY=from-file\n",
		);
		saveEnv("MAXIMUS_VAULT_KEY");
		process.env.MAXIMUS_VAULT_KEY = "from-external";

		const { loadProjectEnv } = await import("../lib/project.js");
		loadProjectEnv();

		expect(process.env.MAXIMUS_VAULT_KEY).toBe("from-external");
	});

	it("handles lines with = in values (e.g., KEY=abc=def)", async () => {
		mkdirSync(join(tmpDir, ".maximus"));
		writeFileSync(
			join(tmpDir, ".maximus", ".env"),
			"MY_TOKEN=abc=def=ghi\n",
		);
		saveEnv("MY_TOKEN");
		delete process.env.MY_TOKEN;

		const { loadProjectEnv } = await import("../lib/project.js");
		loadProjectEnv();

		expect(process.env.MY_TOKEN).toBe("abc=def=ghi");
	});

	it("skips comments (lines starting with #) and blank lines", async () => {
		mkdirSync(join(tmpDir, ".maximus"));
		writeFileSync(
			join(tmpDir, ".maximus", ".env"),
			"# This is a comment\n\nVALID_KEY=valid-value\n  # Indented comment\n\n",
		);
		saveEnv("VALID_KEY");
		delete process.env.VALID_KEY;

		const { loadProjectEnv } = await import("../lib/project.js");
		loadProjectEnv();

		expect(process.env.VALID_KEY).toBe("valid-value");
	});
});
