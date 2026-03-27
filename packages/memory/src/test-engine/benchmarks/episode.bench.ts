import { bench, describe } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { SqliteClient } from "../../sqlite/client.js";
import { EpisodeStore } from "../../sqlite/episodes.js";
import type { Episode } from "@maximus/shared";

function makeEpisode(agentName: string): Episode {
  return {
    id: nanoid(),
    agentName,
    timestamp: Date.now(),
    taskDescription: "Benchmark task for performance testing",
    outcome: "success",
    lessonsLearned: ["Lesson A", "Lesson B"],
    effectiveStrategies: ["Strategy X"],
    failurePatterns: [],
    toolsUsed: ["bash", "read_file"],
    turnCount: 5,
    costUsd: 0.001,
    durationMs: 1200,
    tags: ["benchmark"],
    utilityScore: 0.8,
    retrievalCount: 0,
  };
}

describe("Episode store benchmarks", () => {
  bench(
    "store 100 episodes",
    () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "ep-bench-store-"));
      try {
        const sqlite = SqliteClient.open(join(tmpDir, "operational.db"));
        const store = new EpisodeStore(sqlite.raw);
        for (let i = 0; i < 100; i++) {
          store.store(makeEpisode("bench-agent"));
        }
        sqlite.close();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    { iterations: 10, warmupIterations: 2, time: 30000 },
  );

  bench(
    "query 20 episodes by agent",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "ep-bench-query-"));
      try {
        const sqlite = SqliteClient.open(join(tmpDir, "operational.db"));
        const store = new EpisodeStore(sqlite.raw);
        // Seed 50 episodes
        for (let i = 0; i < 50; i++) {
          store.store(makeEpisode("bench-agent"));
        }
        // Measure query
        store.getByAgent("bench-agent", 20);
        sqlite.close();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    { iterations: 100, warmupIterations: 5, time: 30000 },
  );

  bench(
    "prune low-utility episodes",
    () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "ep-bench-prune-"));
      try {
        const sqlite = SqliteClient.open(join(tmpDir, "operational.db"));
        const store = new EpisodeStore(sqlite.raw);
        // Insert 60 episodes
        for (let i = 0; i < 60; i++) {
          const ep = makeEpisode("bench-agent");
          ep.utilityScore = i < 20 ? 0.1 : 0.9; // 20 low-utility
          store.store(ep);
        }
        // Prune to 40 max
        store.pruneExcess("bench-agent", 40);
        sqlite.close();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    { iterations: 10, warmupIterations: 2, time: 30000 },
  );
});
