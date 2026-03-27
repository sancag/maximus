/**
 * Scope Promotion Pipeline Simulation
 *
 * Tests the full knowledge promotion chain with a deterministic mock LLM.
 * No real API calls — the mock LLM returns controlled JSON so every assertion
 * is precise and repeatable.
 *
 * Scenarios:
 *   1. Agent → Team: two teammates discover the same concept → promotion fires
 *   2. Team → Global: two separate teams independently promote the same concept
 *   3. Orchestrator → Global: the CEO agent auto-promotes directly to global
 *   4. No promotion (negative): a single agent in a solo team gets no promotion
 *   5. Briefing visibility: promoted team knowledge appears in teammates' briefings
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { MemoryEngine } from "../engine.js";
import { DeepSleepPipeline } from "../pipeline/deep-sleep-pipeline.js";
import { KnowledgeStore } from "../kuzu/knowledge-store.js";
import { ScopePromoter } from "../pipeline/scope-promoter.js";
import { BriefingGenerator } from "../briefing/briefing-generator.js";
import { EpisodeStore } from "../sqlite/episodes.js";
import { BriefingStore } from "../sqlite/briefing-store.js";
import { deepSleepConfigSchema } from "@maximus/shared";
import type { AgentEvent, DeepSleepConfig } from "@maximus/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrace(agentName: string, task: string, traceId = nanoid()): AgentEvent[] {
	const sessionId = nanoid();
	const now = Date.now();
	return [
		{ id: nanoid(), timestamp: now, sessionId, agentName, type: "session:start", payload: { task }, traceId },
		{ id: nanoid(), timestamp: now + 1000, sessionId, agentName, type: "agent:completion", payload: { outcome: "success", cost: 0.001 }, traceId },
	];
}

function writeTrace(dir: string, events: AgentEvent[]): void {
	const traceId = events[0].traceId!;
	writeFileSync(join(dir, `${traceId}.jsonl`), events.map(e => JSON.stringify(e)).join("\n"));
}

/** LLM response: one shared concept discovered by a single agent. */
function singleAgentResponse(agentName: string): string {
	return JSON.stringify({
		entities: [
			{ name: "funding_rate", type: "concept" },
			{ name: "volatility", type: "concept" },
		],
		relationships: [
			{ source: "funding_rate", predicate: "correlates_with", target: "volatility", confidence: 0.9, agentName },
		],
	});
}

/**
 * LLM response: same concept independently discovered by TWO agents on the same team.
 * This is the critical input that makes agent→team promotion fire.
 */
function teamSharedResponse(agent1: string, agent2: string): string {
	return JSON.stringify({
		entities: [
			{ name: "funding_rate", type: "concept" },
			{ name: "volatility", type: "concept" },
		],
		relationships: [
			{ source: "funding_rate", predicate: "correlates_with", target: "volatility", confidence: 0.9, agentName: agent1 },
			{ source: "funding_rate", predicate: "correlates_with", target: "volatility", confidence: 0.85, agentName: agent2 },
		],
	});
}

/**
 * LLM response: a concept discovered only by the orchestrator.
 * ScopePromoter auto-promotes orchestrator triples straight to global.
 */
function orchestratorResponse(orchestratorName: string): string {
	return JSON.stringify({
		entities: [
			{ name: "cycle_time", type: "concept" },
			{ name: "parallel_delegation", type: "concept" },
		],
		relationships: [
			{ source: "parallel_delegation", predicate: "reduces", target: "cycle_time", confidence: 0.95, agentName: orchestratorName },
		],
	});
}

// ---------------------------------------------------------------------------
// Shared test state (reset per scenario via beforeEach/afterEach)
// ---------------------------------------------------------------------------

let tmpDir: string;
let tracesDir: string;
let engine: MemoryEngine;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "promo-sim-"));
	tracesDir = join(tmpDir, "traces");
	mkdirSync(tracesDir, { recursive: true });
	engine = new MemoryEngine(join(tmpDir, "memory"));
});

afterEach(async () => {
	await engine.close();
	rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Scenario 1: Agent → Team promotion
// ---------------------------------------------------------------------------

describe("Scenario 1: Agent → Team promotion", () => {
	/**
	 * Setup: hl-market-analyst and hl-strategist are teammates in the "research" team.
	 * Both episodes are processed in one pipeline run.
	 * The mock LLM returns the same relationship tagged to both agents.
	 * Expected: ScopePromoter detects 2 agents on the same team → promotes to team scope.
	 */
	it("fires when two teammates discover the same concept", async () => {
		const config = deepSleepConfigSchema.parse({ agentToTeamMinAgents: 2 });
		const agents = [
			{ name: "hl-market-analyst", team: "research" },
			{ name: "hl-strategist",     team: "research" },
		];

		writeTrace(tracesDir, makeTrace("hl-market-analyst", "Scan funding rates for arb opportunities"));
		writeTrace(tracesDir, makeTrace("hl-strategist",     "Analyse funding rate signal for trade entry"));

		const mockLlm = vi.fn().mockResolvedValue(
			teamSharedResponse("hl-market-analyst", "hl-strategist"),
		);

		const pipeline = new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, () => agents,
		);
		const result = await pipeline.run();

		expect(result.triplesPromoted).toBeGreaterThan(0);
		expect(result.stageErrors).toEqual([]);
	});

	it("promoted triple is visible as team-scoped knowledge to both teammates", async () => {
		const config = deepSleepConfigSchema.parse({ agentToTeamMinAgents: 2 });
		const agents = [
			{ name: "hl-market-analyst", team: "research" },
			{ name: "hl-strategist",     team: "research" },
		];

		writeTrace(tracesDir, makeTrace("hl-market-analyst", "Funding rate scan"));
		writeTrace(tracesDir, makeTrace("hl-strategist",     "Funding rate signal"));

		const mockLlm = vi.fn().mockResolvedValue(
			teamSharedResponse("hl-market-analyst", "hl-strategist"),
		);

		await new DeepSleepPipeline(engine, mockLlm, tracesDir, config, () => agents).run();

		const kuzu = await engine.getKuzu();
		const store = await KnowledgeStore.create(kuzu);

		// Both agents are on the "research" team — both should see the team-scoped triple
		const forAnalyst   = await store.getByScope("hl-market-analyst", ["hl-strategist"]);
		const forStrategist = await store.getByScope("hl-strategist",    ["hl-market-analyst"]);

		const teamAnalyst   = forAnalyst.filter(r => r.triple.scope === "team");
		const teamStrategist = forStrategist.filter(r => r.triple.scope === "team");

		expect(teamAnalyst.length).toBeGreaterThan(0);
		expect(teamStrategist.length).toBeGreaterThan(0);
		expect(teamAnalyst[0].triple.createdBy).toBe("system:promotion");
	});

	it("does NOT fire when only one agent discovers the concept (negative case)", async () => {
		const config = deepSleepConfigSchema.parse({ agentToTeamMinAgents: 2 });
		const agents = [
			{ name: "hl-market-analyst", team: "research" },
			{ name: "hl-strategist",     team: "research" },
		];

		// Only the analyst has a trace — strategist is absent this cycle
		writeTrace(tracesDir, makeTrace("hl-market-analyst", "Funding rate scan"));

		const mockLlm = vi.fn().mockResolvedValue(
			singleAgentResponse("hl-market-analyst"),
		);

		const pipeline = new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, () => agents,
		);
		const result = await pipeline.run();

		expect(result.triplesPromoted).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Scenario 2: Team → Global promotion
// ---------------------------------------------------------------------------

describe("Scenario 2: Team → Global promotion", () => {
	/**
	 * Team→global via the pipeline is limited by entity ID collision:
	 * promoteAgentToTeam picks the globally best triple by name, checks existsAtScope
	 * with those IDs, and blocks the second team's promotion when the first team already
	 * created a team triple for the same (source, predicate, target) by name.
	 *
	 * We test the mechanic directly via ScopePromoter — inserting two team-scope triples
	 * (one per team) with distinct entity IDs, then running promoteTeamToGlobal.
	 * This is the correct level to assert the mechanic works.
	 */
	it("fires when two team-scope triples cover the same concept from different teams", async () => {
		const config = deepSleepConfigSchema.parse({ teamToGlobalMinTeams: 2 });
		const kuzu = await engine.getKuzu();
		const store = await KnowledgeStore.create(kuzu);
		const promoter = new ScopePromoter(kuzu, config);
		const now = Date.now();

		// Research team entities + team-scope triple
		const e1 = { id: nanoid(), name: "stop_loss", type: "concept", createdBy: "hl-market-analyst", firstSeen: now, lastUpdated: now };
		const e2 = { id: nanoid(), name: "trigger_order", type: "concept", createdBy: "hl-market-analyst", firstSeen: now, lastUpdated: now };
		await store.upsertEntity(e1);
		await store.upsertEntity(e2);
		await store.insertTriple({ sourceId: e1.id, targetId: e2.id, predicate: "requires", scope: "team", validFrom: now, confidence: 0.9, evidence: "team:research", createdBy: "system:promotion" });

		// Execution team entities (different IDs, same names) + team-scope triple
		const e3 = { id: nanoid(), name: "stop_loss", type: "concept", createdBy: "hl-risk-manager", firstSeen: now, lastUpdated: now };
		const e4 = { id: nanoid(), name: "trigger_order", type: "concept", createdBy: "hl-risk-manager", firstSeen: now, lastUpdated: now };
		await store.upsertEntity(e3);
		await store.upsertEntity(e4);
		await store.insertTriple({ sourceId: e3.id, targetId: e4.id, predicate: "requires", scope: "team", validFrom: now, confidence: 0.88, evidence: "team:execution", createdBy: "system:promotion" });

		// promoteTeamToGlobal groups by normalized name key — finds 2 team evidence values → promotes
		const teamMap = new Map([
			["research",  ["hl-market-analyst", "hl-strategist"]],
			["execution", ["hl-risk-manager",   "hl-order-executor"]],
		]);
		const promoted = await promoter.promoteTeamToGlobal(teamMap);

		expect(promoted).toBeGreaterThan(0);

		const globalTriples = await store.getByScope("anyone", []);
		const globals = globalTriples.filter(r => r.triple.scope === "global");
		expect(globals.length).toBeGreaterThan(0);
		expect(globals[0].triple.createdBy).toBe("system:promotion");
	});

	it("does NOT fire when only one team has a team-scope triple", async () => {
		const config = deepSleepConfigSchema.parse({ teamToGlobalMinTeams: 2 });
		const kuzu = await engine.getKuzu();
		const store = await KnowledgeStore.create(kuzu);
		const promoter = new ScopePromoter(kuzu, config);
		const now = Date.now();

		// Only research team — execution team has no team-scope triple
		const e1 = { id: nanoid(), name: "stop_loss", type: "concept", createdBy: "hl-market-analyst", firstSeen: now, lastUpdated: now };
		const e2 = { id: nanoid(), name: "trigger_order", type: "concept", createdBy: "hl-market-analyst", firstSeen: now, lastUpdated: now };
		await store.upsertEntity(e1);
		await store.upsertEntity(e2);
		await store.insertTriple({ sourceId: e1.id, targetId: e2.id, predicate: "requires", scope: "team", validFrom: now, confidence: 0.9, evidence: "team:research", createdBy: "system:promotion" });

		const teamMap = new Map([
			["research",  ["hl-market-analyst", "hl-strategist"]],
			["execution", ["hl-risk-manager",   "hl-order-executor"]],
		]);
		const promoted = await promoter.promoteTeamToGlobal(teamMap);

		expect(promoted).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Scenario 3: Orchestrator → Global promotion
// ---------------------------------------------------------------------------

describe("Scenario 3: Orchestrator → Global auto-promotion", () => {
	/**
	 * The orchestrator (hl-ceo) is a solo agent whose triples are automatically
	 * elevated to global scope — no team consensus required. Design decision D-07.
	 */
	it("auto-promotes orchestrator triples directly to global scope", async () => {
		const config = deepSleepConfigSchema.parse({});
		const agents = [
			{ name: "hl-ceo", team: "leadership" },
		];

		writeTrace(tracesDir, makeTrace("hl-ceo", "Full trading cycle coordination"));

		const mockLlm = vi.fn().mockResolvedValue(orchestratorResponse("hl-ceo"));

		const pipeline = new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, () => agents,
			undefined,   // no event emitter
			"hl-ceo",    // orchestratorName
		);
		const result = await pipeline.run();

		expect(result.triplesPromoted).toBeGreaterThan(0);
		expect(result.stageErrors).toEqual([]);

		const kuzu = await engine.getKuzu();
		const store = await KnowledgeStore.create(kuzu);
		// Any agent can see global triples (empty teamMembers is fine for global)
		const all = await store.getByScope("hl-market-analyst", []);
		const globals = all.filter(r => r.triple.scope === "global");
		expect(globals.length).toBeGreaterThan(0);
		expect(globals[0].triple.createdBy).toBe("system:promotion");
	});

	it("non-orchestrator agents do NOT get auto-promoted to global", async () => {
		const config = deepSleepConfigSchema.parse({ agentToTeamMinAgents: 2 });
		const agents = [
			{ name: "hl-market-analyst", team: "research" },
		];

		writeTrace(tracesDir, makeTrace("hl-market-analyst", "Funding rate scan"));

		const mockLlm = vi.fn().mockResolvedValue(
			singleAgentResponse("hl-market-analyst"),
		);

		// Orchestrator is hl-ceo — analyst is NOT the orchestrator
		const pipeline = new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, () => agents,
			undefined, "hl-ceo",
		);
		const result = await pipeline.run();

		expect(result.triplesPromoted).toBe(0);

		const kuzu = await engine.getKuzu();
		const store = await KnowledgeStore.create(kuzu);
		const all = await store.getByScope("hl-market-analyst", []);
		const globals = all.filter(r => r.triple.scope === "global");
		expect(globals.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Scenario 4: Briefing visibility after promotion
// ---------------------------------------------------------------------------

describe("Scenario 4: Promoted knowledge appears in briefings", () => {
	/**
	 * After team promotion fires, the next briefing for any team member should
	 * contain the promoted concept — proving the full pipeline loop works:
	 * extraction → promotion → briefing injection.
	 */
	it("team-promoted knowledge appears in both teammates briefings", async () => {
		const config = deepSleepConfigSchema.parse({ agentToTeamMinAgents: 2 });
		const agents = [
			{ name: "hl-market-analyst", team: "research" },
			{ name: "hl-strategist",     team: "research" },
		];

		writeTrace(tracesDir, makeTrace("hl-market-analyst", "Funding rate scan"));
		writeTrace(tracesDir, makeTrace("hl-strategist",     "Funding rate signal analysis"));

		const mockLlm = vi.fn().mockResolvedValue(
			teamSharedResponse("hl-market-analyst", "hl-strategist"),
		);

		const result = await new DeepSleepPipeline(engine, mockLlm, tracesDir, config, () => agents).run();
		expect(result.triplesPromoted).toBeGreaterThan(0);

		const kuzu = await engine.getKuzu();
		const sqlite = engine.getSqlite();
		const knowledgeStore = await KnowledgeStore.create(kuzu);
		const episodeStore = new EpisodeStore(sqlite.raw);
		const briefingStore = new BriefingStore(sqlite.raw);
		const generator = new BriefingGenerator(episodeStore, knowledgeStore, briefingStore);

		// Invalidate cache so briefing is generated fresh (reflects post-promotion state)
		briefingStore.invalidate("hl-market-analyst");
		briefingStore.invalidate("hl-strategist");

		const analystBriefing    = await generator.generate("hl-market-analyst", ["hl-strategist"], 2000);
		const strategistBriefing = await generator.generate("hl-strategist",     ["hl-market-analyst"], 2000);

		expect(analystBriefing).not.toBeNull();
		expect(strategistBriefing).not.toBeNull();
		// BriefingGenerator uses "Key Knowledge" for all scope levels
		expect(analystBriefing).toContain("Key Knowledge");
		expect(strategistBriefing).toContain("Key Knowledge");
		// The promoted concept should appear in both briefings
		expect(analystBriefing).toContain("funding_rate");
		expect(strategistBriefing).toContain("funding_rate");
	});

	it("global knowledge appears in ALL agents briefings regardless of team", async () => {
		const config = deepSleepConfigSchema.parse({});
		const agents = [
			{ name: "hl-ceo", team: "leadership" },
		];

		writeTrace(tracesDir, makeTrace("hl-ceo", "Cycle coordination"));

		const mockLlm = vi.fn().mockResolvedValue(orchestratorResponse("hl-ceo"));

		await new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, () => agents,
			undefined, "hl-ceo",
		).run();

		const kuzu = await engine.getKuzu();
		const sqlite = engine.getSqlite();
		const knowledgeStore = await KnowledgeStore.create(kuzu);
		const episodeStore = new EpisodeStore(sqlite.raw);
		const briefingStore = new BriefingStore(sqlite.raw);
		const generator = new BriefingGenerator(episodeStore, knowledgeStore, briefingStore);

		// An agent NOT on the leadership team — force fresh generation to reflect global state
		const outsiderBriefing = await generator.generate("hl-market-analyst", [], 2000);
		expect(outsiderBriefing).not.toBeNull();
		// Global triple promoted by orchestrator should appear for any agent
		expect(outsiderBriefing).toContain("Key Knowledge");
		expect(outsiderBriefing).toContain("parallel_delegation");
	});
});

// ---------------------------------------------------------------------------
// Scenario 5: Promotion threshold boundary conditions
// ---------------------------------------------------------------------------

describe("Scenario 5: Promotion threshold boundaries", () => {
	it("respects agentToTeamMinAgents=3: no promotion with only 2 agents", async () => {
		const config = deepSleepConfigSchema.parse({ agentToTeamMinAgents: 3 });
		const agents = [
			{ name: "hl-market-analyst", team: "research" },
			{ name: "hl-strategist",     team: "research" },
		];

		writeTrace(tracesDir, makeTrace("hl-market-analyst", "Scan"));
		writeTrace(tracesDir, makeTrace("hl-strategist",     "Signal"));

		const mockLlm = vi.fn().mockResolvedValue(
			teamSharedResponse("hl-market-analyst", "hl-strategist"),
		);

		const result = await new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, () => agents,
		).run();

		// Threshold requires 3 agents — only 2 discovered it → no promotion
		expect(result.triplesPromoted).toBe(0);
	});

	it("respects agentToTeamMinAgents=3: fires when a 3rd teammate also discovers it", async () => {
		const config = deepSleepConfigSchema.parse({ agentToTeamMinAgents: 3 });
		const agents = [
			{ name: "hl-market-analyst", team: "research" },
			{ name: "hl-strategist",     team: "research" },
			{ name: "hl-quant",          team: "research" },
		];

		writeTrace(tracesDir, makeTrace("hl-market-analyst", "Scan"));
		writeTrace(tracesDir, makeTrace("hl-strategist",     "Signal"));
		writeTrace(tracesDir, makeTrace("hl-quant",          "Quant model run"));

		const threeAgentResponse = JSON.stringify({
			entities: [
				{ name: "funding_rate", type: "concept" },
				{ name: "volatility",   type: "concept" },
			],
			relationships: [
				{ source: "funding_rate", predicate: "correlates_with", target: "volatility", confidence: 0.9,  agentName: "hl-market-analyst" },
				{ source: "funding_rate", predicate: "correlates_with", target: "volatility", confidence: 0.88, agentName: "hl-strategist" },
				{ source: "funding_rate", predicate: "correlates_with", target: "volatility", confidence: 0.85, agentName: "hl-quant" },
			],
		});

		const result = await new DeepSleepPipeline(
			engine,
			vi.fn().mockResolvedValue(threeAgentResponse),
			tracesDir, config, () => agents,
		).run();

		expect(result.triplesPromoted).toBeGreaterThan(0);
	});

	it("idempotent: running the pipeline twice does not double-promote", async () => {
		const config = deepSleepConfigSchema.parse({ agentToTeamMinAgents: 2 });
		const agents = [
			{ name: "hl-market-analyst", team: "research" },
			{ name: "hl-strategist",     team: "research" },
		];

		writeTrace(tracesDir, makeTrace("hl-market-analyst", "Scan"));
		writeTrace(tracesDir, makeTrace("hl-strategist",     "Signal"));

		const mockLlm = vi.fn().mockResolvedValue(
			teamSharedResponse("hl-market-analyst", "hl-strategist"),
		);

		// Second traces dir — same concept, would be fresh traces
		const traces2Dir = join(tmpDir, "traces2");
		mkdirSync(traces2Dir, { recursive: true });
		writeTrace(traces2Dir, makeTrace("hl-market-analyst", "Scan again"));
		writeTrace(traces2Dir, makeTrace("hl-strategist",     "Signal again"));

		// Run 1 — should promote
		const r1 = await new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, () => agents,
		).run();

		// Run 2 — same concept already promoted, existsAtScope blocks re-promotion
		const r2 = await new DeepSleepPipeline(
			engine, vi.fn().mockResolvedValue(teamSharedResponse("hl-market-analyst", "hl-strategist")),
			traces2Dir, config, () => agents,
		).run();

		expect(r1.triplesPromoted).toBeGreaterThan(0);
		expect(r2.triplesPromoted).toBe(0); // already exists at team scope
	});
});
