import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryEngine } from "../engine.js";

let tmpDir: string;

afterEach(async () => {
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

describe("MemoryEngine", () => {
	it("getSqlite() returns a SqliteClient with raw property", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "engine-test-"));
		const engine = new MemoryEngine(tmpDir);
		const sqlite = engine.getSqlite();
		expect(sqlite).toBeDefined();
		expect(sqlite.raw).toBeDefined();
		sqlite.close();
	});

	it("getSqlite() is lazy (same instance on second call)", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "engine-test-"));
		const engine = new MemoryEngine(tmpDir);
		const first = engine.getSqlite();
		const second = engine.getSqlite();
		expect(first).toBe(second);
		first.close();
	});

	it("getSqlite() creates operational.db in memoryDir", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "engine-test-"));
		const engine = new MemoryEngine(tmpDir);
		engine.getSqlite();
		expect(existsSync(join(tmpDir, "operational.db"))).toBe(true);
		engine.getSqlite().close();
	});

	it("close() nulls clients (getSqlite after close creates new instance)", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "engine-test-"));
		const engine = new MemoryEngine(tmpDir);
		const first = engine.getSqlite();
		await engine.close();
		const second = engine.getSqlite();
		expect(first).not.toBe(second);
		await engine.close();
	});
});
