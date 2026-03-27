import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryEngine } from "../engine.js";
import { DeepSleepPipeline } from "../pipeline/deep-sleep-pipeline.js";
import { AgentSimulator } from "../test-engine/simulator/agent-simulator.js";
import { TraceGenerator } from "../test-engine/simulator/trace-generator.js";
import { PipelineValidator } from "../test-engine/validators/pipeline-validator.js";
import { deepSleepConfigSchema } from "@maximus/shared";
import type { DeepSleepConfig } from "@maximus/shared";

let tmpDir: string;
let tracesDir: string;
let engine: MemoryEngine;
let config: DeepSleepConfig;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "deep-sleep-integ-"));
  tracesDir = join(tmpDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  engine = new MemoryEngine(join(tmpDir, "memory"));
  config = deepSleepConfigSchema.parse({});
});

afterEach(async () => {
  await engine.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Mock LLM for entity extraction
const mockLlm = vi.fn().mockResolvedValue(
  JSON.stringify({
    entities: [
      { name: "bash", type: "tool" },
      { name: "file_system", type: "concept" },
    ],
    relationships: [
      { source: "bash", predicate: "accesses", target: "file_system", confidence: 0.9 },
    ],
  })
);

const agentResolver = () => [
  { name: "agent-a", team: "team-alpha" },
  { name: "agent-b", team: "team-alpha" },
  { name: "agent-c", team: "team-beta" },
];

describe("Deep Sleep Pipeline Integration (TEST-04)", () => {
  describe("Pipeline Execution", () => {
    it("processes traces and creates episodes", async () => {
      const simulator = new AgentSimulator();
      const traceGen = new TraceGenerator(tracesDir);
      const validator = new PipelineValidator();

      // Generate and write 5 traces
      for (let i = 0; i < 5; i++) {
        const events = simulator.generateEvents({
          agentName: `agent-${i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : "c"}`,
          task: `Task ${i}`,
          outcome: "success",
          turnCount: 3,
          toolsUsed: ["bash"],
          costUsd: 0.01,
          durationMs: 5000,
        });
        traceGen.writeTrace(events);
      }

      const pipeline = new DeepSleepPipeline(
        engine,
        mockLlm,
        tracesDir,
        config,
        agentResolver
      );

      const result = await pipeline.run();
      const validation = validator.validate(result, {
        expectTracesProcessed: 5,
        expectEpisodesCreated: 5,
        expectNoErrors: true,
      });

      expect(validation.valid).toBe(true);
    });

    it("extracts entities and triples from episodes", async () => {
      const simulator = new AgentSimulator();
      const traceGen = new TraceGenerator(tracesDir);

      const events = simulator.generateEvents({
        agentName: "agent-a",
        task: "List files using bash",
        outcome: "success",
        turnCount: 3,
        toolsUsed: ["bash"],
        costUsd: 0.01,
        durationMs: 5000,
      });
      traceGen.writeTrace(events);

      const pipeline = new DeepSleepPipeline(
        engine,
        mockLlm,
        tracesDir,
        config,
        agentResolver
      );

      const result = await pipeline.run();

      expect(result.entitiesExtracted).toBeGreaterThan(0);
      expect(result.triplesExtracted).toBeGreaterThan(0);
    });

    it("is idempotent - skips already processed traces", async () => {
      const simulator = new AgentSimulator();
      const traceGen = new TraceGenerator(tracesDir);

      const events = simulator.generateEvents({
        agentName: "agent-a",
        task: "Test task",
        outcome: "success",
        turnCount: 2,
        toolsUsed: [],
        costUsd: 0.01,
        durationMs: 3000,
      });
      traceGen.writeTrace(events);

      const pipeline = new DeepSleepPipeline(
        engine,
        mockLlm,
        tracesDir,
        config,
        agentResolver
      );

      // First run
      const result1 = await pipeline.run();
      expect(result1.tracesProcessed).toBe(1);

      // Second run - should skip
      const result2 = await pipeline.run();
      expect(result2.tracesProcessed).toBe(0);
    });
  });

  describe("Scope Promotion", () => {
    it("processes traces for multiple agents in same team", async () => {
      const simulator = new AgentSimulator();
      const traceGen = new TraceGenerator(tracesDir);

      // Generate traces for 2 agents in same team
      for (let i = 0; i < 6; i++) {
        const events = simulator.generateEvents({
          agentName: i % 2 === 0 ? "agent-a" : "agent-b",
          task: "Use bash tool",
          outcome: "success",
          turnCount: 3,
          toolsUsed: ["bash"],
          costUsd: 0.01,
          durationMs: 5000,
        });
        traceGen.writeTrace(events);
      }

      const pipeline = new DeepSleepPipeline(
        engine,
        mockLlm,
        tracesDir,
        config,
        agentResolver
      );

      const result = await pipeline.run();

      expect(result.tracesProcessed).toBe(6);
      expect(result.episodesCreated).toBe(6);
    });

    it("generates briefings for affected agents", async () => {
      const simulator = new AgentSimulator();
      const traceGen = new TraceGenerator(tracesDir);

      // Generate traces for agent-a
      for (let i = 0; i < 3; i++) {
        const events = simulator.generateEvents({
          agentName: "agent-a",
          task: `Task ${i}`,
          outcome: "success",
          turnCount: 3,
          toolsUsed: ["bash"],
          costUsd: 0.01,
          durationMs: 5000,
        });
        traceGen.writeTrace(events);
      }

      const pipeline = new DeepSleepPipeline(
        engine,
        mockLlm,
        tracesDir,
        config,
        agentResolver
      );

      const result = await pipeline.run();

      expect(result.briefingsGenerated).toBeGreaterThan(0);
    });
  });

  describe("Error Handling", () => {
    it("handles stage failures gracefully and continues pipeline", async () => {
      const simulator = new AgentSimulator();
      const traceGen = new TraceGenerator(tracesDir);

      const events = simulator.generateEvents({
        agentName: "agent-a",
        task: "Test task",
        outcome: "success",
        turnCount: 2,
        toolsUsed: [],
        costUsd: 0.01,
        durationMs: 3000,
      });
      traceGen.writeTrace(events);

      // Failing LLM for extraction stage
      const failingLlm = vi.fn().mockRejectedValue(new Error("LLM unavailable"));

      const pipeline = new DeepSleepPipeline(
        engine,
        failingLlm,
        tracesDir,
        config,
        agentResolver
      );

      const result = await pipeline.run();

      // Distill stage should succeed
      expect(result.tracesProcessed).toBe(1);
      expect(result.episodesCreated).toBe(1);

      // Extract stage should have error
      const extractError = result.stageErrors.find((e) => e.stage === "extract");
      expect(extractError).toBeDefined();

      // Subsequent stages should still run (defined in result)
      expect(result.triplesPromoted).toBeDefined();
      expect(result.briefingsGenerated).toBeDefined();
    });

    it("returns valid PipelineResult shape for empty traces dir", async () => {
      const validator = new PipelineValidator();

      const pipeline = new DeepSleepPipeline(
        engine,
        mockLlm,
        tracesDir,
        config,
        agentResolver
      );

      const result = await pipeline.run();
      const validation = validator.validate(result, {
        expectTracesProcessed: 0,
        expectEpisodesCreated: 0,
        expectNoErrors: true,
      });

      expect(validation.valid).toBe(true);
    });
  });
});
