import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { SqliteClient } from "../sqlite/client.js";
import { MetricsTracker } from "../sqlite/metrics.js";
import type Database from "better-sqlite3";

let tmpDir: string;
let client: SqliteClient;
let tracker: MetricsTracker;

function insertEpisode(
	db: Database.Database,
	overrides: {
		agentName?: string;
		outcome?: string;
		turnCount?: number | null;
		costUsd?: number | null;
		durationMs?: number | null;
		timestamp?: number;
	} = {},
): void {
	db.prepare(`
		INSERT INTO episodes (id, agentName, timestamp, taskDescription, outcome, turnCount, costUsd, durationMs)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		nanoid(),
		overrides.agentName ?? "agent-a",
		overrides.timestamp ?? Date.now(),
		"Test task",
		overrides.outcome ?? "success",
		overrides.turnCount !== undefined ? overrides.turnCount : 10,
		overrides.costUsd !== undefined ? overrides.costUsd : 0.01,
		overrides.durationMs !== undefined ? overrides.durationMs : 1000,
	);
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "metrics-tracker-test-"));
	client = SqliteClient.open(join(tmpDir, "test.db"));
	tracker = new MetricsTracker(client.raw);
});

afterEach(() => {
	client.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("MetricsTracker", () => {
	describe("computeAndStore", () => {
		it("calculates correct successRate", () => {
			insertEpisode(client.raw, { outcome: "success" });
			insertEpisode(client.raw, { outcome: "success" });
			insertEpisode(client.raw, { outcome: "failure" });

			const result = tracker.computeAndStore("agent-a");

			expect(result.totalSessions).toBe(3);
			expect(result.successRate).toBeCloseTo(2 / 3, 5);
		});

		it("calculates correct avgTurns", () => {
			insertEpisode(client.raw, { turnCount: 10 });
			insertEpisode(client.raw, { turnCount: 20 });
			insertEpisode(client.raw, { turnCount: 30 });

			const result = tracker.computeAndStore("agent-a");

			expect(result.avgTurns).toBe(20);
		});

		it("handles null turnCount, costUsd, durationMs gracefully", () => {
			insertEpisode(client.raw, { turnCount: 10, costUsd: 0.05, durationMs: 500 });
			insertEpisode(client.raw, { turnCount: null, costUsd: null, durationMs: null });

			const result = tracker.computeAndStore("agent-a");

			expect(result.avgTurns).toBe(10);
			expect(result.avgCostUsd).toBe(0.05);
			expect(result.avgDurationMs).toBe(500);
		});

		it("returns totalSessions=0 and null metrics when no episodes exist", () => {
			const result = tracker.computeAndStore("nonexistent-agent");

			expect(result.totalSessions).toBe(0);
			expect(result.successRate).toBeUndefined();
			expect(result.avgTurns).toBeUndefined();
			expect(result.avgCostUsd).toBeUndefined();
			expect(result.avgDurationMs).toBeUndefined();
		});

		it("persists metrics to agent_metrics table", () => {
			insertEpisode(client.raw, { outcome: "success" });

			const result = tracker.computeAndStore("agent-a");

			const row = client.raw
				.prepare("SELECT * FROM agent_metrics WHERE agentName = ?")
				.get("agent-a") as Record<string, unknown> | undefined;
			expect(row).toBeDefined();
			expect(row!.agentName).toBe("agent-a");
			expect(row!.id).toBe(result.id);
			expect(row!.totalSessions).toBe(1);
		});

		it("respects time window when computing metrics", () => {
			insertEpisode(client.raw, { timestamp: 1000 });
			insertEpisode(client.raw, { timestamp: 5000 });
			insertEpisode(client.raw, { timestamp: 9000 });

			const result = tracker.computeAndStore("agent-a", 4000, 10000);

			expect(result.totalSessions).toBe(2);
		});
	});

	describe("getLatest", () => {
		it("returns most recent metrics snapshot", async () => {
			insertEpisode(client.raw, { outcome: "success" });

			const first = tracker.computeAndStore("agent-a");
			// Ensure timestamp differs
			await new Promise((r) => setTimeout(r, 5));
			const second = tracker.computeAndStore("agent-a");

			const latest = tracker.getLatest("agent-a");
			expect(latest).not.toBeNull();
			expect(latest!.id).toBe(second.id);
			expect(latest!.timestamp).toBeGreaterThanOrEqual(first.timestamp);
		});

		it("returns null when no metrics exist", () => {
			const result = tracker.getLatest("nonexistent");
			expect(result).toBeNull();
		});
	});

	describe("getByAgent", () => {
		it("returns metrics ordered by timestamp DESC with limit", async () => {
			insertEpisode(client.raw, { outcome: "success" });

			tracker.computeAndStore("agent-a");
			await new Promise((r) => setTimeout(r, 5));
			tracker.computeAndStore("agent-a");
			await new Promise((r) => setTimeout(r, 5));
			tracker.computeAndStore("agent-a");

			const results = tracker.getByAgent("agent-a", 2);
			expect(results).toHaveLength(2);
			// Ordered DESC: first item should have higher timestamp
			expect(results[0].timestamp).toBeGreaterThanOrEqual(results[1].timestamp);
		});
	});

	describe("getByWindow", () => {
		it("filters metrics snapshots by timestamp range", async () => {
			insertEpisode(client.raw, { outcome: "success" });

			const m1 = tracker.computeAndStore("agent-a");
			await new Promise((r) => setTimeout(r, 10));
			const m2 = tracker.computeAndStore("agent-a");
			await new Promise((r) => setTimeout(r, 10));
			const m3 = tracker.computeAndStore("agent-a");

			// Include only m2 and m3
			const results = tracker.getByWindow("agent-a", m2.timestamp, m3.timestamp + 1);
			expect(results.length).toBeGreaterThanOrEqual(1);
			expect(results.every((r) => r.timestamp >= m2.timestamp && r.timestamp <= m3.timestamp + 1)).toBe(true);
			const ids = results.map((r) => r.id);
			expect(ids).not.toContain(m1.id);
		});
	});
});
