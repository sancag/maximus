import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteClient } from "../sqlite/client.js";
import { SwarmMetrics } from "../sqlite/swarm-metrics.js";

let tmpDir: string;
let client: SqliteClient;
let swarmMetrics: SwarmMetrics;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "swarm-metrics-test-"));
	client = SqliteClient.open(join(tmpDir, "test.db"));
	swarmMetrics = new SwarmMetrics(client.raw);
});

afterEach(() => {
	client.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("SwarmMetrics", () => {
	describe("recordDelegation", () => {
		it("stores a delegation record with all fields", () => {
			swarmMetrics.recordDelegation({
				id: "del-1",
				delegatorAgent: "orchestrator",
				delegateeAgent: "worker-a",
				taskDescription: "Analyze data",
				outcome: "success",
				timestamp: 1000,
				durationMs: 5000,
			});

			const row = client.raw
				.prepare("SELECT * FROM delegation_metrics WHERE id = ?")
				.get("del-1") as Record<string, unknown> | undefined;

			expect(row).toBeDefined();
			expect(row!.delegatorAgent).toBe("orchestrator");
			expect(row!.delegateeAgent).toBe("worker-a");
			expect(row!.taskDescription).toBe("Analyze data");
			expect(row!.outcome).toBe("success");
			expect(row!.timestamp).toBe(1000);
			expect(row!.durationMs).toBe(5000);
		});

		it("accepts 'success' outcome", () => {
			expect(() =>
				swarmMetrics.recordDelegation({
					id: "del-ok",
					delegatorAgent: "a",
					delegateeAgent: "b",
					outcome: "success",
					timestamp: 1000,
				}),
			).not.toThrow();
		});

		it("accepts 'failure' outcome", () => {
			expect(() =>
				swarmMetrics.recordDelegation({
					id: "del-fail",
					delegatorAgent: "a",
					delegateeAgent: "b",
					outcome: "failure",
					timestamp: 1000,
				}),
			).not.toThrow();
		});

		it("rejects invalid outcome values via SQLite CHECK constraint", () => {
			expect(() =>
				swarmMetrics.recordDelegation({
					id: "del-bad",
					delegatorAgent: "a",
					delegateeAgent: "b",
					outcome: "partial" as "success",
					timestamp: 1000,
				}),
			).toThrow();
		});
	});

	describe("getDelegationSuccessRate", () => {
		it("returns total, successes, and rate for a delegator-delegatee pair", () => {
			swarmMetrics.recordDelegation({
				id: "d1",
				delegatorAgent: "orch",
				delegateeAgent: "worker",
				outcome: "success",
				timestamp: 1000,
			});
			swarmMetrics.recordDelegation({
				id: "d2",
				delegatorAgent: "orch",
				delegateeAgent: "worker",
				outcome: "failure",
				timestamp: 2000,
			});
			swarmMetrics.recordDelegation({
				id: "d3",
				delegatorAgent: "orch",
				delegateeAgent: "worker",
				outcome: "success",
				timestamp: 3000,
			});

			const result = swarmMetrics.getDelegationSuccessRate("orch", "worker");

			expect(result.total).toBe(3);
			expect(result.successes).toBe(2);
			expect(result.rate).toBeCloseTo(2 / 3, 5);
		});

		it("returns rate=0 when all delegations failed", () => {
			swarmMetrics.recordDelegation({
				id: "f1",
				delegatorAgent: "a",
				delegateeAgent: "b",
				outcome: "failure",
				timestamp: 1000,
			});
			swarmMetrics.recordDelegation({
				id: "f2",
				delegatorAgent: "a",
				delegateeAgent: "b",
				outcome: "failure",
				timestamp: 2000,
			});

			const result = swarmMetrics.getDelegationSuccessRate("a", "b");

			expect(result.total).toBe(2);
			expect(result.successes).toBe(0);
			expect(result.rate).toBe(0);
		});

		it("returns rate=1.0 when all delegations succeeded", () => {
			swarmMetrics.recordDelegation({
				id: "s1",
				delegatorAgent: "a",
				delegateeAgent: "b",
				outcome: "success",
				timestamp: 1000,
			});
			swarmMetrics.recordDelegation({
				id: "s2",
				delegatorAgent: "a",
				delegateeAgent: "b",
				outcome: "success",
				timestamp: 2000,
			});

			const result = swarmMetrics.getDelegationSuccessRate("a", "b");

			expect(result.total).toBe(2);
			expect(result.successes).toBe(2);
			expect(result.rate).toBe(1);
		});

		it("returns rate=0 with total=0 when no delegations exist for pair", () => {
			const result = swarmMetrics.getDelegationSuccessRate("x", "y");

			expect(result.total).toBe(0);
			expect(result.successes).toBe(0);
			expect(result.rate).toBe(0);
		});
	});

	describe("getSwarmDelegationSummary", () => {
		it("returns success rates aggregated across all delegator-delegatee pairs", () => {
			// Pair 1: orch -> worker-a (2 success, 1 failure)
			swarmMetrics.recordDelegation({ id: "p1-1", delegatorAgent: "orch", delegateeAgent: "worker-a", outcome: "success", timestamp: 1000 });
			swarmMetrics.recordDelegation({ id: "p1-2", delegatorAgent: "orch", delegateeAgent: "worker-a", outcome: "success", timestamp: 2000 });
			swarmMetrics.recordDelegation({ id: "p1-3", delegatorAgent: "orch", delegateeAgent: "worker-a", outcome: "failure", timestamp: 3000 });

			// Pair 2: orch -> worker-b (1 success)
			swarmMetrics.recordDelegation({ id: "p2-1", delegatorAgent: "orch", delegateeAgent: "worker-b", outcome: "success", timestamp: 1000 });

			const summary = swarmMetrics.getSwarmDelegationSummary();

			expect(summary).toHaveLength(2);

			const pairA = summary.find((s) => s.delegateeAgent === "worker-a");
			expect(pairA).toBeDefined();
			expect(pairA!.total).toBe(3);
			expect(pairA!.successes).toBe(2);
			expect(pairA!.rate).toBeCloseTo(2 / 3, 5);

			const pairB = summary.find((s) => s.delegateeAgent === "worker-b");
			expect(pairB).toBeDefined();
			expect(pairB!.total).toBe(1);
			expect(pairB!.successes).toBe(1);
			expect(pairB!.rate).toBe(1);
		});

		it("returns empty array when no delegations exist", () => {
			const summary = swarmMetrics.getSwarmDelegationSummary();
			expect(summary).toEqual([]);
		});
	});

	describe("getKnowledgeUtilization", () => {
		it("returns total retrievals and agent breakdown sorted desc", () => {
			const result = swarmMetrics.getKnowledgeUtilization([
				{ agentName: "agent-a", totalRetrievals: 50 },
				{ agentName: "agent-b", totalRetrievals: 120 },
				{ agentName: "agent-c", totalRetrievals: 30 },
			]);

			expect(result.totalRetrievals).toBe(200);
			expect(result.agentBreakdown).toHaveLength(3);
			// Sorted desc by retrievals
			expect(result.agentBreakdown[0]).toEqual({ agentName: "agent-b", retrievals: 120 });
			expect(result.agentBreakdown[1]).toEqual({ agentName: "agent-a", retrievals: 50 });
			expect(result.agentBreakdown[2]).toEqual({ agentName: "agent-c", retrievals: 30 });
		});

		it("returns zero totals for empty input", () => {
			const result = swarmMetrics.getKnowledgeUtilization([]);

			expect(result.totalRetrievals).toBe(0);
			expect(result.agentBreakdown).toEqual([]);
		});
	});
});
