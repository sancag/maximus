/**
 * Gap analysis engine tests.
 *
 * Tests that GapAnalyzer correctly identifies intentional gaps in database state:
 * - Missing tables
 * - Orphaned entities (no relationships)
 * - Episodes with inconsistent outcome
 * - Performance concerns (agents with excessive episodes)
 * - Invalid scope values
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { MemoryEngine } from "../../engine.js";
import { KnowledgeStore } from "../../kuzu/knowledge-store.js";
import { GapAnalyzer, runGapAnalysis } from "../../test-engine/validators/gap-analyzer.js";
import type { GapReport } from "../../test-engine/validators/gap-analyzer.js";
import type { KnowledgeEntity, KnowledgeTriple } from "@maximus/shared";

let tmpDir: string;
let engine: MemoryEngine;

function makeEntity(
  createdBy: string,
  overrides: Partial<KnowledgeEntity> = {},
): KnowledgeEntity {
  const id = nanoid();
  return {
    id,
    name: `Entity-${id.slice(0, 6)}`,
    type: "concept",
    createdBy,
    firstSeen: Date.now(),
    lastUpdated: Date.now(),
    ...overrides,
  };
}

function makeTriple(
  sourceId: string,
  targetId: string,
  createdBy = "test-agent",
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gap-test-"));
  engine = new MemoryEngine(join(tmpDir, "memory"));
});

afterEach(async () => {
  await engine.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GapAnalyzer", () => {
  describe("analyze() - basic report structure", () => {
    it("returns a GapReport with timestamp ISO string", async () => {
      const analyzer = new GapAnalyzer(engine);
      const report = await analyzer.analyze();

      expect(report.timestamp).toBeDefined();
      expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
    });

    it("returns GapReport with findings array and metrics object", async () => {
      const analyzer = new GapAnalyzer(engine);
      const report = await analyzer.analyze();

      expect(Array.isArray(report.findings)).toBe(true);
      expect(typeof report.metrics.totalEpisodes).toBe("number");
      expect(typeof report.metrics.totalEntities).toBe("number");
      expect(typeof report.metrics.totalTriples).toBe("number");
      expect(typeof report.metrics.coveragePercent).toBe("number");
    });

    it("each GapFinding has required fields with valid severity", async () => {
      // Seed some data to potentially trigger findings
      const db = engine.getSqlite().raw;
      db.prepare(`
        INSERT INTO episodes (id, agentName, timestamp, taskDescription, outcome,
          lessonsLearned, effectiveStrategies, failurePatterns, toolsUsed, tags,
          utilityScore, retrievalCount)
        VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 0.5, 0)
      `).run(nanoid(), "test-agent", Date.now(), "Test task", "failure");

      const analyzer = new GapAnalyzer(engine);
      const report = await analyzer.analyze();

      for (const finding of report.findings) {
        expect(["P0", "P1", "P2", "P3"]).toContain(finding.severity);
        expect(typeof finding.category).toBe("string");
        expect(finding.category.length).toBeGreaterThan(0);
        expect(typeof finding.description).toBe("string");
        expect(finding.description.length).toBeGreaterThan(0);
        expect(typeof finding.recommendation).toBe("string");
        expect(finding.recommendation.length).toBeGreaterThan(0);
      }
    });
  });

  describe("analyze() - episode checks", () => {
    it("detects agents with zero episodes when queried against zero-count", async () => {
      // With empty DB, totalEpisodes should be 0 in metrics
      const analyzer = new GapAnalyzer(engine);
      const report = await analyzer.analyze();

      expect(report.metrics.totalEpisodes).toBe(0);
    });

    it("counts episodes correctly in metrics", async () => {
      const db = engine.getSqlite().raw;
      const insertEpisode = (id: string, agent: string, outcome = "success") => {
        db.prepare(`
          INSERT INTO episodes (id, agentName, timestamp, taskDescription, outcome,
            lessonsLearned, effectiveStrategies, failurePatterns, toolsUsed, tags,
            utilityScore, retrievalCount)
          VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 0.5, 0)
        `).run(id, agent, Date.now(), "Test task", outcome);
      };

      insertEpisode(nanoid(), "agent-a");
      insertEpisode(nanoid(), "agent-a");
      insertEpisode(nanoid(), "agent-b");

      const analyzer = new GapAnalyzer(engine);
      const report = await analyzer.analyze();

      expect(report.metrics.totalEpisodes).toBe(3);
    });

    it("detects episodes with failure outcome but no failure patterns (P2)", async () => {
      const db = engine.getSqlite().raw;
      // Insert failure episode with empty failure patterns
      db.prepare(`
        INSERT INTO episodes (id, agentName, timestamp, taskDescription, outcome,
          lessonsLearned, effectiveStrategies, failurePatterns, toolsUsed, tags,
          utilityScore, retrievalCount)
        VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 0.3, 0)
      `).run(nanoid(), "test-agent", Date.now(), "Task that failed", "failure");

      const analyzer = new GapAnalyzer(engine);
      const report = await analyzer.analyze();

      const incorrectFailureFinding = report.findings.find(
        (f) =>
          f.category === "correctness" &&
          f.description.includes("failure") &&
          f.description.includes("no failure patterns"),
      );

      expect(incorrectFailureFinding).toBeDefined();
      expect(incorrectFailureFinding?.severity).toBe("P2");
    });

    it("does not flag failure with failurePatterns when they are populated", async () => {
      const db = engine.getSqlite().raw;
      // Insert failure episode with populated failure patterns
      db.prepare(`
        INSERT INTO episodes (id, agentName, timestamp, taskDescription, outcome,
          lessonsLearned, effectiveStrategies, failurePatterns, toolsUsed, tags,
          utilityScore, retrievalCount)
        VALUES (?, ?, ?, ?, ?, '[]', '[]', '["timeout error"]', '[]', '[]', 0.3, 0)
      `).run(nanoid(), "test-agent", Date.now(), "Task that failed", "failure");

      const analyzer = new GapAnalyzer(engine);
      const report = await analyzer.analyze();

      const incorrectFailureFinding = report.findings.find(
        (f) =>
          f.category === "correctness" &&
          f.description.includes("failure") &&
          f.description.includes("no failure patterns"),
      );

      expect(incorrectFailureFinding).toBeUndefined();
    });
  });

  describe("analyze() - knowledge graph checks", () => {
    it("counts entities and triples correctly in metrics", async () => {
      const kuzu = await engine.getKuzu();
      const store = await KnowledgeStore.create(kuzu);

      const e1 = makeEntity("test-agent");
      const e2 = makeEntity("test-agent");
      const e3 = makeEntity("test-agent");

      await store.upsertEntity(e1);
      await store.upsertEntity(e2);
      await store.upsertEntity(e3);
      await store.insertTriple(makeTriple(e1.id, e2.id));
      await store.insertTriple(makeTriple(e2.id, e3.id));

      const analyzer = new GapAnalyzer(engine);
      const report = await analyzer.analyze();

      expect(report.metrics.totalEntities).toBe(3);
      expect(report.metrics.totalTriples).toBe(2);
    });

    it("detects orphaned entities (entity with no relationships) as P2", async () => {
      const kuzu = await engine.getKuzu();
      const store = await KnowledgeStore.create(kuzu);

      // Create connected entities
      const e1 = makeEntity("test-agent");
      const e2 = makeEntity("test-agent");
      await store.upsertEntity(e1);
      await store.upsertEntity(e2);
      await store.insertTriple(makeTriple(e1.id, e2.id));

      // Create an orphaned entity with no connections
      const orphan = makeEntity("test-agent", { name: "Orphaned Entity" });
      await store.upsertEntity(orphan);

      const analyzer = new GapAnalyzer(engine);
      const report = await analyzer.analyze();

      const orphanFinding = report.findings.find(
        (f) => f.category === "knowledge-health" && f.description.includes("orphaned"),
      );

      expect(orphanFinding).toBeDefined();
      expect(orphanFinding?.severity).toBe("P2");
      expect(orphanFinding?.description).toContain("1");
    });

    it("does not report orphaned entities when all entities have relationships", async () => {
      const kuzu = await engine.getKuzu();
      const store = await KnowledgeStore.create(kuzu);

      const e1 = makeEntity("test-agent");
      const e2 = makeEntity("test-agent");
      await store.upsertEntity(e1);
      await store.upsertEntity(e2);
      await store.insertTriple(makeTriple(e1.id, e2.id));

      const analyzer = new GapAnalyzer(engine);
      const report = await analyzer.analyze();

      const orphanFinding = report.findings.find(
        (f) => f.category === "knowledge-health" && f.description.includes("orphaned"),
      );

      expect(orphanFinding).toBeUndefined();
    });
  });

  describe("analyze() - performance checks", () => {
    it("flags agents with > 500 episodes as P1 performance concern", async () => {
      const db = engine.getSqlite().raw;

      // Insert 501 episodes for one agent (using a loop)
      const insertMany = db.prepare(`
        INSERT INTO episodes (id, agentName, timestamp, taskDescription, outcome,
          lessonsLearned, effectiveStrategies, failurePatterns, toolsUsed, tags,
          utilityScore, retrievalCount)
        VALUES (@id, @agentName, @ts, @task, 'success', '[]', '[]', '[]', '[]', '[]', 0.5, 0)
      `);

      const insertAll = db.transaction(() => {
        for (let i = 0; i < 501; i++) {
          insertMany.run({
            id: nanoid(),
            agentName: "heavy-agent",
            ts: Date.now() + i,
            task: `Task ${i}`,
          });
        }
      });
      insertAll();

      const analyzer = new GapAnalyzer(engine);
      const report = await analyzer.analyze();

      const perfFinding = report.findings.find(
        (f) =>
          f.category === "performance" &&
          f.description.includes("heavy-agent"),
      );

      expect(perfFinding).toBeDefined();
      expect(perfFinding?.severity).toBe("P1");
      expect(perfFinding?.description).toContain("501");
    });
  });

  describe("analyze() - scope checks", () => {
    it("returns no scope findings when all triples have valid scope values", async () => {
      const kuzu = await engine.getKuzu();
      const store = await KnowledgeStore.create(kuzu);

      const e1 = makeEntity("test-agent");
      const e2 = makeEntity("test-agent");
      await store.upsertEntity(e1);
      await store.upsertEntity(e2);
      await store.insertTriple(makeTriple(e1.id, e2.id, "test-agent", "agent"));

      const analyzer = new GapAnalyzer(engine);
      const report = await analyzer.analyze();

      const scopeFinding = report.findings.find(
        (f) => f.category === "correctness" && f.description.includes("scope"),
      );

      expect(scopeFinding).toBeUndefined();
    });
  });
});

describe("runGapAnalysis", () => {
  it("creates MemoryEngine, runs analysis, closes engine, and returns report", async () => {
    // Seed some basic data
    const e = new MemoryEngine(join(tmpDir, "memory"));
    const db = e.getSqlite().raw;
    db.prepare(`
      INSERT INTO episodes (id, agentName, timestamp, taskDescription, outcome,
        lessonsLearned, effectiveStrategies, failurePatterns, toolsUsed, tags,
        utilityScore, retrievalCount)
      VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 0.7, 0)
    `).run(nanoid(), "test-agent", Date.now(), "Analysis test task", "success");
    await e.close();

    // runGapAnalysis should work with the seeded data
    const report: GapReport = await runGapAnalysis(join(tmpDir, "memory"));

    expect(report).toBeDefined();
    expect(typeof report.timestamp).toBe("string");
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
    expect(Array.isArray(report.findings)).toBe(true);
    expect(report.metrics.totalEpisodes).toBe(1);
  });

  it("returns empty findings for a clean healthy database", async () => {
    // Just initialize engine to create schema, don't add any data
    engine.getSqlite(); // Initialize SQLite
    await engine.close();
    engine = new MemoryEngine(join(tmpDir, "memory")); // Reset to avoid double-close

    const report = await runGapAnalysis(join(tmpDir, "memory"));

    // Healthy empty DB should have no high-severity findings
    const p0Findings = report.findings.filter((f) => f.severity === "P0");
    expect(p0Findings.length).toBe(0);
  });
});
