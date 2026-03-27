import { bench, describe } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { DeepSleepPipeline } from "../../pipeline/deep-sleep-pipeline.js";
import { MemoryEngine } from "../../engine.js";
import { AgentSimulator } from "../simulator/agent-simulator.js";
import { TraceGenerator } from "../simulator/trace-generator.js";
import { deepSleepConfigSchema } from "@maximus/shared";

// Mock LLM that returns empty entity extraction (fast, no network calls)
const mockLlm = vi
  .fn()
  .mockResolvedValue(JSON.stringify({ entities: [], relationships: [] }));

const agentResolver = () => [
  { name: "pipeline-agent-1", team: "bench-team" },
  { name: "pipeline-agent-2", team: "bench-team" },
  { name: "pipeline-agent-3", team: "bench-team" },
];

describe("Pipeline benchmarks", () => {
  bench(
    "deep sleep cycle (100 traces)",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pipe-bench-"));
      const tracesDir = join(tmpDir, "traces");
      mkdirSync(tracesDir, { recursive: true });

      try {
        const engine = new MemoryEngine(join(tmpDir, "memory"));
        const simulator = new AgentSimulator();
        const generator = new TraceGenerator(tracesDir);
        const config = deepSleepConfigSchema.parse({});

        // Generate 100 traces (split across 3 agents)
        const agents = ["pipeline-agent-1", "pipeline-agent-2", "pipeline-agent-3"];
        for (let i = 0; i < 100; i++) {
          const agentName = agents[i % agents.length];
          const events = simulator.generateEvents({
            agentName,
            task: `Benchmark task ${i}`,
            outcome: i % 5 === 0 ? "failure" : "success",
            turnCount: 2,
            toolsUsed: ["bash"],
            costUsd: 0.001,
            durationMs: 500,
          });
          generator.writeTrace(events);
        }

        const pipeline = new DeepSleepPipeline(
          engine,
          mockLlm,
          tracesDir,
          config,
          agentResolver,
        );

        await pipeline.run();
        await engine.close();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    { iterations: 3, warmupIterations: 1, time: 300000 },
  );
});
