import { bench, describe, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { KuzuClient } from "../../kuzu/client.js";
import { KnowledgeStore } from "../../kuzu/knowledge-store.js";
import type { KnowledgeEntity, KnowledgeTriple } from "@maximus/shared";

function makeEntity(createdBy: string): KnowledgeEntity {
  const id = nanoid();
  return {
    id,
    name: `Entity-${id.slice(0, 6)}`,
    type: "concept",
    createdBy,
    firstSeen: Date.now(),
    lastUpdated: Date.now(),
  };
}

function makeTriple(
  sourceId: string,
  targetId: string,
  createdBy: string,
  scope: "agent" | "team" | "global" = "agent",
): KnowledgeTriple {
  return {
    sourceId,
    targetId,
    predicate: "relates_to",
    scope,
    validFrom: Date.now(),
    confidence: 0.9,
    createdBy,
  };
}

describe("Knowledge store benchmarks", () => {
  let tmpDir: string;
  let kuzu: KuzuClient;
  let store: KnowledgeStore;

  // Pre-seeded entities for scope query benchmark
  const seededEntities: KnowledgeEntity[] = [];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kg-bench-"));
    kuzu = await KuzuClient.open(join(tmpDir, "knowledge.kuzu"));
    store = await KnowledgeStore.create(kuzu);

    // Seed entities and triples for scope query benchmark
    for (let i = 0; i < 30; i++) {
      const entity = makeEntity("bench-agent");
      await store.upsertEntity(entity);
      seededEntities.push(entity);
    }
    // Agent scope triples
    for (let i = 0; i < 5; i++) {
      await store.insertTriple(
        makeTriple(
          seededEntities[i].id,
          seededEntities[i + 1].id,
          "bench-agent",
          "agent",
        ),
      );
    }
    // Team scope triples
    for (let i = 6; i < 11; i++) {
      await store.insertTriple(
        makeTriple(
          seededEntities[i].id,
          seededEntities[i + 1].id,
          "teammate",
          "team",
        ),
      );
    }
    // Global scope triples
    for (let i = 12; i < 17; i++) {
      await store.insertTriple(
        makeTriple(
          seededEntities[i].id,
          seededEntities[i + 1].id,
          "global-agent",
          "global",
        ),
      );
    }
  });

  afterAll(async () => {
    await kuzu.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  bench(
    "upsert 50 entities",
    async () => {
      for (let i = 0; i < 50; i++) {
        await store.upsertEntity(makeEntity("bench-agent"));
      }
    },
    { iterations: 5, warmupIterations: 1, time: 60000 },
  );

  bench(
    "scope chain query",
    async () => {
      await store.getByScope("bench-agent", ["teammate"]);
    },
    { iterations: 50, warmupIterations: 3, time: 60000 },
  );
});
