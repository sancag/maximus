import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteClient } from "../sqlite/client.js";
import { StrategyRegistry } from "../sqlite/strategy-registry.js";

let tmpDir: string;
let client: SqliteClient;
let registry: StrategyRegistry;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "strategy-registry-test-"));
	client = SqliteClient.open(join(tmpDir, "test.db"));
	registry = new StrategyRegistry(client.raw);
});

afterEach(() => {
	client.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("StrategyRegistry", () => {
	it("record() creates new strategy entry with usageCount=1", () => {
		registry.record("agent-alpha", "Batch processing", "success");

		const strategies = registry.getByAgent("agent-alpha");
		expect(strategies).toHaveLength(1);
		expect(strategies[0].strategyText).toBe("Batch processing");
		expect(strategies[0].usageCount).toBe(1);
		expect(strategies[0].agentName).toBe("agent-alpha");
	});

	it("record() increments usageCount on duplicate (agentName, strategyText)", () => {
		registry.record("agent-alpha", "Batch processing", "success");
		registry.record("agent-alpha", "Batch processing", "success");
		registry.record("agent-alpha", "Batch processing", "failure");

		const strategies = registry.getByAgent("agent-alpha");
		expect(strategies).toHaveLength(1);
		expect(strategies[0].usageCount).toBe(3);
	});

	it("record() tracks successCount and failureCount separately", () => {
		registry.record("agent-alpha", "Rate limiting", "success");
		registry.record("agent-alpha", "Rate limiting", "success");
		registry.record("agent-alpha", "Rate limiting", "failure");
		registry.record("agent-alpha", "Rate limiting", "partial"); // partial = neither success nor failure

		const strategies = registry.getByAgent("agent-alpha");
		expect(strategies).toHaveLength(1);
		expect(strategies[0].successCount).toBe(2);
		expect(strategies[0].failureCount).toBe(1);
		expect(strategies[0].usageCount).toBe(4);
	});

	it("getTopStrategies() returns top N by usageCount DESC", () => {
		// Create 3 strategies with different usage counts
		registry.record("agent-alpha", "Strategy A", "success");

		registry.record("agent-alpha", "Strategy B", "success");
		registry.record("agent-alpha", "Strategy B", "success");
		registry.record("agent-alpha", "Strategy B", "success");

		registry.record("agent-alpha", "Strategy C", "success");
		registry.record("agent-alpha", "Strategy C", "success");

		const top2 = registry.getTopStrategies("agent-alpha", 2);
		expect(top2).toHaveLength(2);
		expect(top2[0].strategyText).toBe("Strategy B");
		expect(top2[0].usageCount).toBe(3);
		expect(top2[1].strategyText).toBe("Strategy C");
		expect(top2[1].usageCount).toBe(2);
	});

	it("successRate computed correctly from successCount / (successCount + failureCount)", () => {
		registry.record("agent-alpha", "Test strategy", "success");
		registry.record("agent-alpha", "Test strategy", "success");
		registry.record("agent-alpha", "Test strategy", "failure");
		registry.record("agent-alpha", "Test strategy", "partial"); // does not count toward success or failure

		const strategies = registry.getByAgent("agent-alpha");
		expect(strategies).toHaveLength(1);
		// successRate = 2 / (2 + 1) = 0.6667
		expect(strategies[0].successRate).toBeCloseTo(2 / 3, 4);
	});

	it("different agents have independent strategy registries", () => {
		registry.record("agent-alpha", "Shared strategy", "success");
		registry.record("agent-alpha", "Shared strategy", "success");
		registry.record("agent-beta", "Shared strategy", "failure");

		const alphaStrategies = registry.getByAgent("agent-alpha");
		const betaStrategies = registry.getByAgent("agent-beta");

		expect(alphaStrategies).toHaveLength(1);
		expect(alphaStrategies[0].usageCount).toBe(2);
		expect(alphaStrategies[0].successCount).toBe(2);

		expect(betaStrategies).toHaveLength(1);
		expect(betaStrategies[0].usageCount).toBe(1);
		expect(betaStrategies[0].failureCount).toBe(1);
	});
});
