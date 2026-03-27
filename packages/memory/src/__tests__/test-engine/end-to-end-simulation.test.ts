/**
 * End-to-end multi-agent simulation tests.
 *
 * Simulates 5 agents across 2 teams with 20 sessions each (100 total traces),
 * validates cross-agent knowledge sharing, team-level briefings, and
 * scope promotion across team boundaries.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeepSleepPipeline } from "../../pipeline/deep-sleep-pipeline.js";
import { MemoryEngine } from "../../engine.js";
import { KnowledgeStore } from "../../kuzu/knowledge-store.js";
import { EpisodeStore } from "../../sqlite/episodes.js";
import { AgentSimulator } from "../../test-engine/simulator/agent-simulator.js";
import { TraceGenerator } from "../../test-engine/simulator/trace-generator.js";
import { deepSleepConfigSchema } from "@maximus/shared";
import type { PipelineResult } from "@maximus/shared";

// Agent definitions for the 5-agent, 2-team simulation
const AGENTS = [
  { name: "code-writer", team: "team-alpha", tools: ["bash", "file_write"] },
  { name: "code-reviewer", team: "team-alpha", tools: ["read_file", "grep"] },
  { name: "test-writer", team: "team-alpha", tools: ["bash", "test_runner"] },
  { name: "doc-writer", team: "team-beta", tools: ["file_write", "read_file"] },
  { name: "doc-reviewer", team: "team-beta", tools: ["read_file"] },
];

// Scenario distribution: 60% simple, 20% tool, 10% error, 10% multi-turn
function pickScenario(sessionIndex: number): {
  outcome: "success" | "failure" | "partial";
  turnCount: number;
  tools: string[];
} {
  const r = sessionIndex % 10;
  if (r < 6) {
    // 60% simple success
    return { outcome: "success", turnCount: 2, tools: [] };
  } else if (r < 8) {
    // 20% tool usage
    return { outcome: "success", turnCount: 4, tools: ["bash"] };
  } else if (r === 8) {
    // 10% error recovery
    return { outcome: "failure", turnCount: 3, tools: [] };
  } else {
    // 10% multi-turn
    return { outcome: "success", turnCount: 8, tools: ["bash", "read_file"] };
  }
}

let tmpDir: string;
let tracesDir: string;
let engine: MemoryEngine;
let pipelineResult: PipelineResult;

// Mock LLM that extracts entities based on agent specialization
const mockLlm = vi.fn().mockImplementation(async (prompt: string) => {
  // For team-alpha agents, extract code-related entities
  // For team-beta agents, extract doc-related entities
  if (prompt.includes("code-writer") || prompt.includes("code-reviewer") || prompt.includes("test-writer")) {
    return JSON.stringify({
      entities: [
        { id: "code-pattern-1", name: "TypeScript best practices", type: "pattern", createdBy: "code-writer" },
        { id: "test-pattern-1", name: "Unit testing patterns", type: "pattern", createdBy: "test-writer" },
      ],
      relationships: [],
    });
  } else if (prompt.includes("doc-writer") || prompt.includes("doc-reviewer")) {
    return JSON.stringify({
      entities: [
        { id: "doc-pattern-1", name: "Documentation standards", type: "pattern", createdBy: "doc-writer" },
      ],
      relationships: [],
    });
  }
  return JSON.stringify({ entities: [], relationships: [] });
});

const agentResolver = () =>
  AGENTS.map((a) => ({ name: a.name, team: a.team }));

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "e2e-sim-"));
  tracesDir = join(tmpDir, "traces");
  mkdirSync(tracesDir, { recursive: true });

  engine = new MemoryEngine(join(tmpDir, "memory"));
  const simulator = new AgentSimulator();
  const generator = new TraceGenerator(tracesDir);
  const config = deepSleepConfigSchema.parse({});

  // Generate 20 sessions per agent = 100 total traces
  for (const agent of AGENTS) {
    for (let session = 0; session < 20; session++) {
      const scenario = pickScenario(session);
      const events = simulator.generateEvents({
        agentName: agent.name,
        task: `${agent.name} task session ${session}`,
        outcome: scenario.outcome,
        turnCount: scenario.turnCount,
        toolsUsed: scenario.tools.length > 0 ? scenario.tools : agent.tools,
        costUsd: 0.005,
        durationMs: 2000 + session * 100,
      });
      generator.writeTrace(events);
    }
  }

  const pipeline = new DeepSleepPipeline(
    engine,
    mockLlm,
    tracesDir,
    config,
    agentResolver,
  );

  pipelineResult = await pipeline.run();
}, 120000);

afterAll(async () => {
  await engine.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("End-to-end multi-agent simulation", () => {
  it("processes 100 traces (20 per agent across 5 agents)", () => {
    expect(pipelineResult.tracesProcessed).toBe(100);
  });

  it("creates 100 episodes (one per trace)", () => {
    expect(pipelineResult.episodesCreated).toBe(100);
  });

  it("produces no stage errors", () => {
    expect(pipelineResult.stageErrors).toEqual([]);
  });

  it("generates briefings for affected agents (at least 5)", () => {
    expect(pipelineResult.briefingsGenerated).toBeGreaterThanOrEqual(5);
  });

  it("episodes are stored correctly in SQLite per agent", () => {
    const sqlite = engine.getSqlite();
    const episodeStore = new EpisodeStore(sqlite.raw);

    for (const agent of AGENTS) {
      const episodes = episodeStore.getByAgent(agent.name, 25);
      expect(episodes.length).toBe(20);
      // Verify all episodes belong to this agent
      for (const ep of episodes) {
        expect(ep.agentName).toBe(agent.name);
      }
    }
  });

  it("all agent episodes have valid outcomes", () => {
    const sqlite = engine.getSqlite();
    const episodeStore = new EpisodeStore(sqlite.raw);

    for (const agent of AGENTS) {
      const episodes = episodeStore.getByAgent(agent.name, 25);
      for (const ep of episodes) {
        expect(["success", "failure", "partial"]).toContain(ep.outcome);
        expect(ep.taskDescription).toContain(agent.name);
      }
    }
  });

  it("team-alpha agent cannot see team-beta agent-scoped knowledge directly", async () => {
    const kuzu = await engine.getKuzu();
    const store = await KnowledgeStore.create(kuzu);

    // Query team-alpha agent scope - should not include team-beta private knowledge
    const alphaResults = await store.getByScope("code-writer", [
      "code-reviewer",
      "test-writer",
    ]);

    // All team-scoped results should be from team-alpha members or global
    for (const r of alphaResults) {
      if (r.triple.scope === "team") {
        // Team-scoped triples from beta-specific agents should not appear
        // (doc-writer and doc-reviewer's team triples are not in team-alpha scope chain)
        expect(["code-writer", "code-reviewer", "test-writer"]).toContain(
          r.triple.createdBy,
        );
      }
    }
  });

  it("global-scoped triples are accessible to agents from both teams", async () => {
    const kuzu = await engine.getKuzu();
    const store = await KnowledgeStore.create(kuzu);

    // Get global triples count from alpha agent's perspective
    const alphaResults = await store.getByScope("code-writer", [
      "code-reviewer",
      "test-writer",
    ]);
    const betaResults = await store.getByScope("doc-writer", ["doc-reviewer"]);

    const alphaGlobalTriples = alphaResults.filter(
      (r) => r.triple.scope === "global",
    );
    const betaGlobalTriples = betaResults.filter(
      (r) => r.triple.scope === "global",
    );

    // Both teams see the same global triples
    expect(alphaGlobalTriples.length).toBe(betaGlobalTriples.length);
  });

  it("episode outcomes reflect simulated scenario distribution", () => {
    const sqlite = engine.getSqlite();
    const db = sqlite.raw;

    const rows = db
      .prepare("SELECT outcome, COUNT(*) as c FROM episodes GROUP BY outcome")
      .all() as Array<{ outcome: string; c: number }>;

    const counts = Object.fromEntries(rows.map((r) => [r.outcome, r.c]));

    // With 100 traces: ~60 success from simple, ~20 success from tool, ~10 from multi-turn = ~90 success
    // ~10 failure from error recovery
    // Total successes should be dominant
    expect(counts["success"] ?? 0).toBeGreaterThan(counts["failure"] ?? 0);
  });

  it("pipeline result has all required PipelineResult fields", () => {
    expect(typeof pipelineResult.tracesProcessed).toBe("number");
    expect(typeof pipelineResult.episodesCreated).toBe("number");
    expect(typeof pipelineResult.entitiesExtracted).toBe("number");
    expect(typeof pipelineResult.triplesExtracted).toBe("number");
    expect(typeof pipelineResult.triplesPromoted).toBe("number");
    expect(typeof pipelineResult.briefingsGenerated).toBe("number");
    expect(typeof pipelineResult.triplesPruned).toBe("number");
    expect(typeof pipelineResult.episodesPruned).toBe("number");
    expect(typeof pipelineResult.entitiesPruned).toBe("number");
    expect(Array.isArray(pipelineResult.stageErrors)).toBe(true);
  });
});
