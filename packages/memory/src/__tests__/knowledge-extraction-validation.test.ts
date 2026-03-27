import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KuzuClient } from "../kuzu/client.js";
import { KnowledgeStore } from "../kuzu/knowledge-store.js";
import { EntityExtractor } from "../extract/entity-extractor.js";
import { AgentSimulator } from "../test-engine/simulator/agent-simulator.js";
import { EpisodeDistiller } from "../trace/distiller.js";
import { KnowledgeValidator } from "../test-engine/validators/knowledge-validator.js";
import type { KnowledgeEntity, KnowledgeTriple } from "@maximus/shared";

let tmpDir: string;
let kuzuClient: KuzuClient;
let knowledgeStore: KnowledgeStore;
const simulator = new AgentSimulator();
const distiller = new EpisodeDistiller();

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "knowledge-test-"));
  kuzuClient = await KuzuClient.open(join(tmpDir, "knowledge.kuzu"));
  knowledgeStore = await KnowledgeStore.create(kuzuClient);
});

afterEach(async () => {
  await kuzuClient.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Mock LLM that returns deterministic entities based on content
function createMockLlm() {
  return vi.fn().mockImplementation((prompt: string) => {
    if (prompt.includes("bash") || prompt.includes("tool")) {
      return Promise.resolve(
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
    }
    if (prompt.includes("error") || prompt.includes("failure")) {
      return Promise.resolve(
        JSON.stringify({
          entities: [
            { name: "error_handling", type: "strategy" },
            { name: "retry_logic", type: "pattern" },
          ],
          relationships: [
            { source: "error_handling", predicate: "requires", target: "retry_logic", confidence: 0.8 },
          ],
        })
      );
    }
    return Promise.resolve(JSON.stringify({ entities: [], relationships: [] }));
  });
}

describe("Knowledge Extraction Validation (TEST-03)", () => {
  describe("Entity Extraction", () => {
    it("extracts entities from episodes with tools", async () => {
      const mockLlm = createMockLlm();
      const extractor = new EntityExtractor(knowledgeStore, mockLlm);

      const events = simulator.generateEvents({
        agentName: "test-agent",
        task: "List files using bash",
        outcome: "success",
        turnCount: 3,
        toolsUsed: ["bash"],
        costUsd: 0.01,
        durationMs: 5000,
      });

      const episode = distiller.distill("test-agent", events);
      const result = await extractor.extractFromEpisodes([episode]);

      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.entities.some((e) => e.name === "bash")).toBe(true);
    });

    it("extracts relationships between entities", async () => {
      const mockLlm = createMockLlm();
      const extractor = new EntityExtractor(knowledgeStore, mockLlm);

      const events = simulator.generateEvents({
        agentName: "test-agent",
        task: "List files using bash",
        outcome: "success",
        turnCount: 3,
        toolsUsed: ["bash"],
        costUsd: 0.01,
        durationMs: 5000,
      });

      const episode = distiller.distill("test-agent", events);
      const result = await extractor.extractFromEpisodes([episode]);

      expect(result.triples.length).toBeGreaterThan(0);
      expect(result.triples[0]).toHaveProperty("sourceId");
      expect(result.triples[0]).toHaveProperty("predicate");
      expect(result.triples[0]).toHaveProperty("targetId");
    });
  });

  describe("Knowledge Store Operations", () => {
    it("upserts entities with correct properties", async () => {
      const entity: KnowledgeEntity = {
        id: "entity-1",
        name: "bash",
        type: "tool",
        createdBy: "test-agent",
        firstSeen: Date.now(),
        lastUpdated: Date.now(),
      };

      await knowledgeStore.upsertEntity(entity);
      const retrieved = await knowledgeStore.getEntity(entity.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(entity.id);
      expect(retrieved!.name).toBe(entity.name);
      expect(retrieved!.type).toBe(entity.type);
      expect(retrieved!.createdBy).toBe(entity.createdBy);
    });

    it("inserts triples with scope and timestamps", async () => {
      const sourceEntity: KnowledgeEntity = {
        id: "source-1",
        name: "bash",
        type: "tool",
        createdBy: "test-agent",
        firstSeen: Date.now(),
        lastUpdated: Date.now(),
      };
      const targetEntity: KnowledgeEntity = {
        id: "target-1",
        name: "file_system",
        type: "concept",
        createdBy: "test-agent",
        firstSeen: Date.now(),
        lastUpdated: Date.now(),
      };

      await knowledgeStore.upsertEntity(sourceEntity);
      await knowledgeStore.upsertEntity(targetEntity);

      const triple: KnowledgeTriple = {
        sourceId: sourceEntity.id,
        targetId: targetEntity.id,
        predicate: "accesses",
        scope: "agent",
        validFrom: Date.now(),
        validTo: 0,
        confidence: 0.9,
        createdBy: "test-agent",
      };

      await knowledgeStore.insertTriple(triple);
      const exists = await knowledgeStore.findActiveTriple(
        sourceEntity.id,
        triple.predicate,
        targetEntity.id
      );

      expect(exists).toBe(true);
    });

    it("scope chain query returns agent + global triples", async () => {
      const entity1: KnowledgeEntity = {
        id: "entity-1",
        name: "bash",
        type: "tool",
        createdBy: "agent-a",
        firstSeen: Date.now(),
        lastUpdated: Date.now(),
      };
      await knowledgeStore.upsertEntity(entity1);

      // Agent scope triple
      const agentTriple: KnowledgeTriple = {
        sourceId: entity1.id,
        targetId: entity1.id,
        predicate: "test-agent",
        scope: "agent",
        validFrom: Date.now(),
        validTo: 0,
        confidence: 0.9,
        createdBy: "agent-a",
      };
      await knowledgeStore.insertTriple(agentTriple);

      // Global scope triple
      const globalTriple: KnowledgeTriple = {
        sourceId: entity1.id,
        targetId: entity1.id,
        predicate: "test-global",
        scope: "global",
        validFrom: Date.now(),
        validTo: 0,
        confidence: 0.9,
        createdBy: "orchestrator",
      };
      await knowledgeStore.insertTriple(globalTriple);

      const results = await knowledgeStore.getByScope("agent-a", []);
      const scopes = results.map((r) => r.triple.scope);

      expect(scopes).toContain("agent");
      expect(scopes).toContain("global");
    });

    it("validates extracted entities against schema", async () => {
      const mockLlm = createMockLlm();
      const extractor = new EntityExtractor(knowledgeStore, mockLlm);
      const validator = new KnowledgeValidator();

      const events = simulator.generateEvents({
        agentName: "test-agent",
        task: "List files using bash tool",
        outcome: "success",
        turnCount: 3,
        toolsUsed: ["bash"],
        costUsd: 0.01,
        durationMs: 5000,
      });

      const episode = distiller.distill("test-agent", events);
      const result = await extractor.extractFromEpisodes([episode]);

      const validation = validator.validate(result.entities, result.triples);
      expect(validation.valid).toBe(true);
      expect(validation.entityErrors).toHaveLength(0);
      expect(validation.tripleErrors).toHaveLength(0);
    });

    it("returns empty result for empty episodes array", async () => {
      const mockLlm = createMockLlm();
      const extractor = new EntityExtractor(knowledgeStore, mockLlm);

      const result = await extractor.extractFromEpisodes([]);

      expect(result.entities).toHaveLength(0);
      expect(result.triples).toHaveLength(0);
    });

    it("temporal supersession updates active triple", async () => {
      const sourceEntity: KnowledgeEntity = {
        id: "source-super",
        name: "api_client",
        type: "concept",
        createdBy: "agent-a",
        firstSeen: Date.now(),
        lastUpdated: Date.now(),
      };
      const targetEntity: KnowledgeEntity = {
        id: "target-super",
        name: "auth_service",
        type: "service",
        createdBy: "agent-a",
        firstSeen: Date.now(),
        lastUpdated: Date.now(),
      };

      await knowledgeStore.upsertEntity(sourceEntity);
      await knowledgeStore.upsertEntity(targetEntity);

      const triple1: KnowledgeTriple = {
        sourceId: sourceEntity.id,
        targetId: targetEntity.id,
        predicate: "connects_to",
        scope: "agent",
        validFrom: Date.now() - 1000,
        validTo: 0,
        confidence: 0.8,
        createdBy: "agent-a",
      };

      await knowledgeStore.insertTriple(triple1);

      // Insert with supersession
      const triple2: KnowledgeTriple = {
        sourceId: sourceEntity.id,
        targetId: targetEntity.id,
        predicate: "connects_to",
        scope: "agent",
        validFrom: Date.now(),
        validTo: 0,
        confidence: 0.9,
        createdBy: "agent-a",
      };

      await knowledgeStore.insertTripleWithSupersession(triple2);

      // New triple should be active
      const exists = await knowledgeStore.findActiveTriple(
        sourceEntity.id,
        "connects_to",
        targetEntity.id
      );
      expect(exists).toBe(true);
    });
  });
});
