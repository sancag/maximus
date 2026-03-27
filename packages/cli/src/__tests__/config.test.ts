import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: vi.fn() };
});

describe("project-local config", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "maximus-config-test-"));
		const os = await import("node:os");
		vi.mocked(os.homedir).mockReturnValue(tmpDir);
	});

	afterEach(() => {
		vi.resetModules();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("getProjectDir returns .maximus in home dir", async () => {
		const { getProjectDir } = await import("../lib/project.js");
		expect(getProjectDir()).toBe(join(tmpDir, ".maximus"));
	});

	it("hasProject returns false when no .maximus/", async () => {
		const { hasProject } = await import("../lib/project.js");
		expect(hasProject()).toBe(false);
	});

	it("hasProject returns true when .maximus/ exists", async () => {
		mkdirSync(join(tmpDir, ".maximus"));
		const { hasProject } = await import("../lib/project.js");
		expect(hasProject()).toBe(true);
	});

	it("getProjectConfig reads from .maximus/config.json", async () => {
		mkdirSync(join(tmpDir, ".maximus"));
		writeFileSync(
			join(tmpDir, ".maximus", "config.json"),
			JSON.stringify({ name: "test", port: 5000 }),
		);
		const { getProjectConfig } = await import("../lib/project.js");
		const config = getProjectConfig();
		expect(config.name).toBe("test");
		expect(config.port).toBe(5000);
	});

	it("getProjectConfig throws when no .maximus/", async () => {
		const { getProjectConfig } = await import("../lib/project.js");
		expect(() => getProjectConfig()).toThrow("No .maximus/ found");
	});

	it("getPidPath returns .maximus/maximus.pid", async () => {
		const { getPidPath } = await import("../lib/project.js");
		expect(getPidPath()).toBe(join(tmpDir, ".maximus", "maximus.pid"));
	});
});
