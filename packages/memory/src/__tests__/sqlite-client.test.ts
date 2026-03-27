import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteClient } from "../sqlite/client.js";
import { KUZU_SCHEMA_DDL } from "../kuzu/schema.js";

let tmpDir: string;

afterEach(() => {
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

describe("SqliteClient", () => {
	it("creates database with WAL mode", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "mem-test-"));
		const client = SqliteClient.open(join(tmpDir, "test.db"));
		const result = client.raw.pragma("journal_mode");
		expect(result).toEqual([{ journal_mode: "wal" }]);
		client.close();
	});

	it("creates all required tables", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "mem-test-"));
		const client = SqliteClient.open(join(tmpDir, "test.db"));
		const tables = client.raw
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.all()
			.map((r: Record<string, unknown>) => r.name);
		expect(tables).toContain("_schema_version");
		expect(tables).toContain("agent_metrics");
		expect(tables).toContain("briefings");
		expect(tables).toContain("episodes");
		client.close();
	});

	it("creates indexes", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "mem-test-"));
		const client = SqliteClient.open(join(tmpDir, "test.db"));
		const indexes = client.raw
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
			)
			.all()
			.map((r: Record<string, unknown>) => r.name);
		expect(indexes).toContain("idx_episodes_agent");
		expect(indexes).toContain("idx_metrics_agent");
		client.close();
	});

	it("is idempotent (can open same db twice)", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "mem-test-"));
		const dbPath = join(tmpDir, "test.db");
		const client1 = SqliteClient.open(dbPath);
		client1.close();
		const client2 = SqliteClient.open(dbPath);
		const tables = client2.raw
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.all()
			.map((r: Record<string, unknown>) => r.name);
		expect(tables).toContain("episodes");
		client2.close();
	});

	it("episodes table enforces outcome CHECK constraint", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "mem-test-"));
		const client = SqliteClient.open(join(tmpDir, "test.db"));
		expect(() =>
			client.raw
				.prepare(
					`INSERT INTO episodes (id, agentName, timestamp, taskDescription, outcome, tags)
					 VALUES ('ep-1', 'agent-a', 1000, 'test task', 'invalid', '[]')`,
				)
				.run(),
		).toThrow();
		client.close();
	});
});

describe("KUZU_SCHEMA_DDL", () => {
	it("is an array with 2 entries", () => {
		expect(Array.isArray(KUZU_SCHEMA_DDL)).toBe(true);
		expect(KUZU_SCHEMA_DDL).toHaveLength(2);
	});

	it("first entry creates Entity node table with PRIMARY KEY", () => {
		expect(KUZU_SCHEMA_DDL[0]).toContain("Entity");
		expect(KUZU_SCHEMA_DDL[0]).toContain("PRIMARY KEY");
	});

	it("second entry creates Related rel table FROM Entity TO Entity", () => {
		expect(KUZU_SCHEMA_DDL[1]).toContain("Related");
		expect(KUZU_SCHEMA_DDL[1]).toContain("FROM Entity TO Entity");
	});
});
