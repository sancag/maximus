import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KuzuClient } from "../kuzu/client.js";
import { KnowledgeStore } from "../kuzu/knowledge-store.js";
import { ScopePromoter } from "../pipeline/scope-promoter.js";
import { deepSleepConfigSchema } from "@maximus/shared";
import type { KnowledgeEntity, KnowledgeTriple, AgentMetrics } from "@maximus/shared";
import type { MetricsTracker } from "../sqlite/metrics.js";

let tmpDir: string;
let client: KuzuClient;
let store: KnowledgeStore;
let promoter: ScopePromoter;

const defaultConfig = deepSleepConfigSchema.parse({});

beforeEach(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), "sp-test-"));
	client = await KuzuClient.open(join(tmpDir, "test.kuzu"));
	store = await KnowledgeStore.create(client);
	promoter = new ScopePromoter(client, defaultConfig);
});

afterEach(async () => {
	await client.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

const makeEntity = (overrides: Partial<KnowledgeEntity> = {}): KnowledgeEntity => ({
	id: "e1",
	name: "Instantly API",
	type: "api",
	createdBy: "agent-alpha",
	firstSeen: 1000,
	lastUpdated: 1000,
	...overrides,
});

const makeTriple = (overrides: Partial<KnowledgeTriple> = {}): KnowledgeTriple => ({
	sourceId: "e1",
	targetId: "e2",
	predicate: "uses",
	scope: "agent",
	validFrom: 1000,
	confidence: 0.9,
	evidence: "Observed in task logs",
	createdBy: "agent-alpha",
	...overrides,
});

describe("ScopePromoter", () => {
	it("promotes when 2+ agents share same triple (agent -> team)", async () => {
		// Two agents both created triples with same source+predicate+target entities
		await store.upsertEntity(makeEntity({ id: "e1", name: "Instantly API" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Email Service" }));

		await store.insertTriple(
			makeTriple({ sourceId: "e1", targetId: "e2", createdBy: "agent-alpha", scope: "agent" }),
		);
		await store.insertTriple(
			makeTriple({ sourceId: "e1", targetId: "e2", createdBy: "agent-beta", scope: "agent" }),
		);

		const teamMap = new Map([["team-sales", ["agent-alpha", "agent-beta"]]]);
		const promoted = await promoter.promoteAgentToTeam(teamMap);

		expect(promoted).toBeGreaterThanOrEqual(1);

		// Verify team-scope triple exists
		const rows = await client.executePrepared(
			`MATCH (s:Entity)-[r:Related]->(t:Entity) WHERE r.scope = 'team' AND r.validTo = 0 RETURN r.createdBy AS createdBy`,
			{},
		);
		expect(rows.length).toBeGreaterThanOrEqual(1);
		expect((rows[0] as Record<string, unknown>).createdBy).toBe("system:promotion");
	});

	it("promotes when retrievalCount exceeds threshold", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Instantly API" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Email Service" }));

		// Bump retrieval count above threshold (default 5)
		for (let i = 0; i < 6; i++) {
			await store.incrementRetrievalCount("e1");
		}

		await store.insertTriple(
			makeTriple({
				sourceId: "e1",
				targetId: "e2",
				createdBy: "agent-alpha",
				scope: "agent",
				confidence: 0.8,
			}),
		);

		const teamMap = new Map([["team-sales", ["agent-alpha"]]]);
		const promoted = await promoter.promoteAgentToTeam(teamMap);

		expect(promoted).toBeGreaterThanOrEqual(1);
	});

	it("does NOT promote when thresholds not met", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Instantly API" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Email Service" }));

		// Only one agent, no high retrieval count
		await store.insertTriple(
			makeTriple({ sourceId: "e1", targetId: "e2", createdBy: "agent-alpha", scope: "agent" }),
		);

		const teamMap = new Map([["team-sales", ["agent-alpha"]]]);
		const promoted = await promoter.promoteAgentToTeam(teamMap);

		expect(promoted).toBe(0);
	});

	it("preserves original triple (copy semantics)", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Instantly API" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Email Service" }));

		await store.insertTriple(
			makeTriple({ sourceId: "e1", targetId: "e2", createdBy: "agent-alpha", scope: "agent" }),
		);
		await store.insertTriple(
			makeTriple({ sourceId: "e1", targetId: "e2", createdBy: "agent-beta", scope: "agent" }),
		);

		const teamMap = new Map([["team-sales", ["agent-alpha", "agent-beta"]]]);
		await promoter.promoteAgentToTeam(teamMap);

		// Original agent-scope triples should still exist
		const agentTriples = await client.executePrepared(
			`MATCH (s:Entity)-[r:Related]->(t:Entity) WHERE r.scope = 'agent' AND r.validTo = 0 RETURN count(r) AS cnt`,
			{},
		);
		expect(Number((agentTriples[0] as Record<string, unknown>).cnt)).toBe(2);
	});

	it("promotes orchestrator triples to global scope", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Instantly API" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Email Service" }));

		await store.insertTriple(
			makeTriple({
				sourceId: "e1",
				targetId: "e2",
				createdBy: "orchestrator",
				scope: "agent",
			}),
		);

		const promoted = await promoter.promoteOrchestratorToGlobal("orchestrator");

		expect(promoted).toBe(1);

		// Verify global triple
		const globalTriples = await client.executePrepared(
			`MATCH (s:Entity)-[r:Related]->(t:Entity) WHERE r.scope = 'global' AND r.validTo = 0 RETURN r.createdBy AS createdBy`,
			{},
		);
		expect(globalTriples.length).toBe(1);
		expect((globalTriples[0] as Record<string, unknown>).createdBy).toBe("system:promotion");
	});

	it("normalizes entity names for matching", async () => {
		// Two entities with differently-cased names should still match
		await store.upsertEntity(makeEntity({ id: "e1", name: "  Instantly  API " }));
		await store.upsertEntity(makeEntity({ id: "e1b", name: "instantly api" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Email Service" }));
		await store.upsertEntity(makeEntity({ id: "e2b", name: "email service" }));

		await store.insertTriple(
			makeTriple({
				sourceId: "e1",
				targetId: "e2",
				createdBy: "agent-alpha",
				scope: "agent",
				predicate: "uses",
			}),
		);
		await store.insertTriple(
			makeTriple({
				sourceId: "e1b",
				targetId: "e2b",
				createdBy: "agent-beta",
				scope: "agent",
				predicate: "uses",
			}),
		);

		const teamMap = new Map([["team-sales", ["agent-alpha", "agent-beta"]]]);
		const promoted = await promoter.promoteAgentToTeam(teamMap);

		expect(promoted).toBeGreaterThanOrEqual(1);
	});

	it("does NOT create duplicate promotion if already exists at target scope", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Instantly API" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Email Service" }));

		await store.insertTriple(
			makeTriple({ sourceId: "e1", targetId: "e2", createdBy: "agent-alpha", scope: "agent" }),
		);
		await store.insertTriple(
			makeTriple({ sourceId: "e1", targetId: "e2", createdBy: "agent-beta", scope: "agent" }),
		);

		const teamMap = new Map([["team-sales", ["agent-alpha", "agent-beta"]]]);

		// Promote twice
		await promoter.promoteAgentToTeam(teamMap);
		const second = await promoter.promoteAgentToTeam(teamMap);

		expect(second).toBe(0);

		// Only one team triple should exist
		const teamTriples = await client.executePrepared(
			`MATCH (s:Entity)-[r:Related]->(t:Entity) WHERE r.scope = 'team' AND r.validTo = 0 RETURN count(r) AS cnt`,
			{},
		);
		expect(Number((teamTriples[0] as Record<string, unknown>).cnt)).toBe(1);
	});

	it("promotes team to global when appearing in 2+ teams", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Instantly API" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Email Service" }));

		// Two team-scope triples from different teams
		await store.insertTriple(
			makeTriple({
				sourceId: "e1",
				targetId: "e2",
				createdBy: "system:promotion",
				scope: "team",
				evidence: "team:team-sales",
			}),
		);
		await store.insertTriple(
			makeTriple({
				sourceId: "e1",
				targetId: "e2",
				createdBy: "system:promotion",
				scope: "team",
				evidence: "team:team-marketing",
			}),
		);

		const teamMap = new Map([
			["team-sales", ["agent-alpha"]],
			["team-marketing", ["agent-beta"]],
		]);
		const promoted = await promoter.promoteTeamToGlobal(teamMap);

		expect(promoted).toBeGreaterThanOrEqual(1);

		// Verify global triple exists
		const globalTriples = await client.executePrepared(
			`MATCH (s:Entity)-[r:Related]->(t:Entity) WHERE r.scope = 'global' AND r.validTo = 0 RETURN count(r) AS cnt`,
			{},
		);
		expect(Number((globalTriples[0] as Record<string, unknown>).cnt)).toBeGreaterThanOrEqual(1);
	});

	it("runAll executes all promotion stages and returns total count", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Instantly API" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Email Service" }));

		await store.insertTriple(
			makeTriple({ sourceId: "e1", targetId: "e2", createdBy: "agent-alpha", scope: "agent" }),
		);
		await store.insertTriple(
			makeTriple({ sourceId: "e1", targetId: "e2", createdBy: "agent-beta", scope: "agent" }),
		);

		const teamMap = new Map([["team-sales", ["agent-alpha", "agent-beta"]]]);
		const total = await promoter.runAll(teamMap);

		expect(total).toBeGreaterThanOrEqual(1);
	});

	describe("metric-driven promotion", () => {
		function makeMockMetricsTracker(
			metricsMap: Record<string, Partial<AgentMetrics>>,
		): MetricsTracker {
			return {
				getLatest: (agentName: string) => {
					const m = metricsMap[agentName];
					if (!m) return null;
					return {
						id: "m1",
						agentName,
						timestamp: Date.now(),
						totalSessions: 10,
						...m,
					} as AgentMetrics;
				},
			} as unknown as MetricsTracker;
		}

		it("promotes faster for high-success agents (reduced threshold)", async () => {
			const mockMetrics = makeMockMetricsTracker({
				"agent-alpha": { successRate: 0.9 },
			});
			const metricPromoter = new ScopePromoter(client, defaultConfig, mockMetrics);

			await store.upsertEntity(makeEntity({ id: "e1", name: "Instantly API" }));
			await store.upsertEntity(makeEntity({ id: "e2", name: "Email Service" }));

			// Default threshold is 5. With 0.9 success rate, threshold should be floor(5*0.6)=3
			// So retrieval count of 4 should be enough (> 3)
			for (let i = 0; i < 4; i++) {
				await store.incrementRetrievalCount("e1");
			}

			await store.insertTriple(
				makeTriple({
					sourceId: "e1",
					targetId: "e2",
					createdBy: "agent-alpha",
					scope: "agent",
					confidence: 0.8,
				}),
			);

			const teamMap = new Map([["team-sales", ["agent-alpha"]]]);
			const promoted = await metricPromoter.promoteAgentToTeam(teamMap);

			// Should promote because threshold is reduced to 3 for high-success agent
			expect(promoted).toBeGreaterThanOrEqual(1);
		});

		it("skips promotion for low-success agents", async () => {
			const mockMetrics = makeMockMetricsTracker({
				"agent-alpha": { successRate: 0.2 },
			});
			const metricPromoter = new ScopePromoter(client, defaultConfig, mockMetrics);

			await store.upsertEntity(makeEntity({ id: "e1", name: "Instantly API" }));
			await store.upsertEntity(makeEntity({ id: "e2", name: "Email Service" }));

			// Even with high retrieval count, low-success agents should be skipped
			for (let i = 0; i < 10; i++) {
				await store.incrementRetrievalCount("e1");
			}

			await store.insertTriple(
				makeTriple({
					sourceId: "e1",
					targetId: "e2",
					createdBy: "agent-alpha",
					scope: "agent",
					confidence: 0.9,
				}),
			);

			const teamMap = new Map([["team-sales", ["agent-alpha"]]]);
			const promoted = await metricPromoter.promoteAgentToTeam(teamMap);

			// Should NOT promote because agent has low success rate
			expect(promoted).toBe(0);
		});
	});
});
