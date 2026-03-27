import { MemoryEngine } from "../../engine.js";

/**
 * A single gap finding with severity rating and remediation guidance.
 */
export interface GapFinding {
  severity: "P0" | "P1" | "P2" | "P3";
  category: string;
  description: string;
  recommendation: string;
}

/**
 * Summary metrics included in a gap report.
 */
export interface GapMetrics {
  totalEpisodes: number;
  totalEntities: number;
  totalTriples: number;
  coveragePercent: number;
}

/**
 * Complete gap analysis report.
 */
export interface GapReport {
  timestamp: string;
  findings: GapFinding[];
  metrics: GapMetrics;
}

/**
 * GapAnalyzer examines database state and identifies issues across multiple
 * categories: feature completeness, episode quality, knowledge health,
 * performance thresholds, and correctness.
 *
 * Severity guide:
 * - P0: Data loss, corruption, or blocking functionality
 * - P1: Significant functional degradation or performance issue
 * - P2: Non-critical functional gaps or potential issues
 * - P3: Cosmetic, minor improvements, or low-priority optimizations
 */
export class GapAnalyzer {
  constructor(private engine: MemoryEngine) {}

  /**
   * Run all gap analysis checks and return a GapReport.
   */
  async analyze(): Promise<GapReport> {
    const findings: GapFinding[] = [];
    const metrics: GapMetrics = {
      totalEpisodes: 0,
      totalEntities: 0,
      totalTriples: 0,
      coveragePercent: 0,
    };

    // --- SQLite-based checks ---
    await this.checkFeatureCompleteness(findings, metrics);
    await this.checkEpisodeDistribution(findings, metrics);
    await this.checkEpisodeCorrectness(findings);

    // --- Kuzu-based checks ---
    await this.checkKnowledgeHealth(findings, metrics);
    await this.checkScopeIssues(findings);

    // Compute coverage: if we have both episodes and entities, coverage is high
    if (metrics.totalEpisodes > 0 || metrics.totalEntities > 0) {
      const total = metrics.totalEpisodes + metrics.totalEntities;
      // Simple heuristic: triples per entity as knowledge density
      const density =
        metrics.totalEntities > 0
          ? metrics.totalTriples / metrics.totalEntities
          : 0;
      // Coverage = ratio of filled data to expected data
      metrics.coveragePercent = Math.min(100, Math.round((density / 3) * 100));
    }

    return {
      timestamp: new Date().toISOString(),
      findings,
      metrics,
    };
  }

  // ---------------------------------------------------------------------------
  // Private check methods
  // ---------------------------------------------------------------------------

  /**
   * Check that required SQLite tables exist and are not empty.
   */
  private async checkFeatureCompleteness(
    findings: GapFinding[],
    metrics: GapMetrics,
  ): Promise<void> {
    try {
      const db = this.engine.getSqlite().raw;

      // Check required tables exist
      const requiredTables = [
        "episodes",
        "agent_metrics",
        "briefings",
        "processed_traces",
      ];
      const existingTablesRows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      const existingTables = new Set(existingTablesRows.map((r) => r.name));

      for (const table of requiredTables) {
        if (!existingTables.has(table)) {
          findings.push({
            severity: "P0",
            category: "feature-completeness",
            description: `Required table '${table}' is missing from SQLite schema`,
            recommendation: `Run SqliteClient.open() with the current SQLITE_SCHEMA_DDL to create all required tables`,
          });
        }
      }

      // Get episode count
      if (existingTables.has("episodes")) {
        const row = db.prepare("SELECT COUNT(*) as c FROM episodes").get() as {
          c: number;
        };
        metrics.totalEpisodes = row.c;
      }
    } catch (err) {
      findings.push({
        severity: "P0",
        category: "feature-completeness",
        description: `Failed to check SQLite schema: ${err instanceof Error ? err.message : String(err)}`,
        recommendation: "Verify SQLite database is accessible and schema DDL is applied",
      });
    }
  }

  /**
   * Check episode distribution: agents with no episodes, episodes with missing fields.
   */
  private async checkEpisodeDistribution(
    findings: GapFinding[],
    _metrics: GapMetrics,
  ): Promise<void> {
    try {
      const db = this.engine.getSqlite().raw;

      // Check for agents with > 500 episodes (performance concern)
      const highEpisodeAgents = db
        .prepare(
          "SELECT agentName, COUNT(*) as c FROM episodes GROUP BY agentName HAVING c > 500",
        )
        .all() as Array<{ agentName: string; c: number }>;

      for (const { agentName, c } of highEpisodeAgents) {
        findings.push({
          severity: "P1",
          category: "performance",
          description: `Agent '${agentName}' has ${c} episodes, exceeding recommended 500 limit`,
          recommendation: `Run EpisodeStore.pruneExcess('${agentName}', 500) to reduce episode count and improve query performance`,
        });
      }

      // Check for episodes with NULL or empty task descriptions
      const emptyTaskRows = db
        .prepare(
          "SELECT COUNT(*) as c FROM episodes WHERE taskDescription IS NULL OR taskDescription = ''",
        )
        .get() as { c: number };

      if (emptyTaskRows.c > 0) {
        findings.push({
          severity: "P2",
          category: "data-quality",
          description: `${emptyTaskRows.c} episodes have empty or null taskDescription`,
          recommendation: "Verify EpisodeDistiller correctly extracts task descriptions from trace events",
        });
      }
    } catch {
      // Non-critical: episode distribution check failure
    }
  }

  /**
   * Check episode correctness: failure outcomes should have failure patterns.
   */
  private async checkEpisodeCorrectness(
    findings: GapFinding[],
  ): Promise<void> {
    try {
      const db = this.engine.getSqlite().raw;

      // Episodes with outcome='failure' but empty failurePatterns
      const inconsistentFailures = db
        .prepare(
          `SELECT COUNT(*) as c FROM episodes WHERE outcome = 'failure' AND (failurePatterns = '[]' OR failurePatterns IS NULL)`,
        )
        .get() as { c: number };

      if (inconsistentFailures.c > 0) {
        findings.push({
          severity: "P2",
          category: "correctness",
          description: `${inconsistentFailures.c} episodes have outcome='failure' but no failure patterns recorded`,
          recommendation: "Enhance EpisodeDistiller to extract failure patterns from agent:error events in traces",
        });
      }
    } catch {
      // Non-critical: correctness check failure
    }
  }

  /**
   * Check knowledge graph health: orphaned entities, entity/triple counts.
   */
  private async checkKnowledgeHealth(
    findings: GapFinding[],
    metrics: GapMetrics,
  ): Promise<void> {
    try {
      const kuzu = await this.engine.getKuzu();

      // Count total entities
      const entityCountRows = await kuzu.executePrepared(
        "MATCH (e:Entity) RETURN COUNT(*) AS c",
        {},
      );
      const entityCountRow = entityCountRows[0] as Record<string, unknown>;
      metrics.totalEntities = Number(entityCountRow?.c ?? 0);

      // Count total active triples
      const tripleCountRows = await kuzu.executePrepared(
        "MATCH (s:Entity)-[r:Related]->(t:Entity) WHERE r.validTo = 0 RETURN COUNT(*) AS c",
        {},
      );
      const tripleCountRow = tripleCountRows[0] as Record<string, unknown>;
      metrics.totalTriples = Number(tripleCountRow?.c ?? 0);

      // Find orphaned entities (no incoming or outgoing relationships)
      const orphanRows = await kuzu.executePrepared(
        `MATCH (e:Entity) WHERE NOT EXISTS { MATCH (e)-[:Related]-() } AND NOT EXISTS { MATCH ()-[:Related]->(e) } RETURN e.id AS eid, e.name AS ename`,
        {},
      );

      if (orphanRows.length > 0) {
        findings.push({
          severity: "P2",
          category: "knowledge-health",
          description: `${orphanRows.length} orphaned entities found in knowledge graph (no incoming or outgoing relationships)`,
          recommendation: "Run DeepSleepPipeline pruning stage or manually delete orphaned entities with: MATCH (e:Entity) WHERE NOT EXISTS { MATCH (e)-[:Related]-() } DELETE e",
        });
      }
    } catch (err) {
      findings.push({
        severity: "P1",
        category: "knowledge-health",
        description: `Failed to analyze knowledge graph: ${err instanceof Error ? err.message : String(err)}`,
        recommendation: "Verify Kuzu database is accessible and schema is initialized",
      });
    }
  }

  /**
   * Check scope validity: triples should have valid scope values.
   */
  private async checkScopeIssues(findings: GapFinding[]): Promise<void> {
    try {
      const kuzu = await this.engine.getKuzu();

      // Check for triples with invalid scope values
      const validScopes = new Set(["agent", "team", "global"]);
      const allScopesRows = await kuzu.executePrepared(
        "MATCH (s:Entity)-[r:Related]->(t:Entity) RETURN DISTINCT r.scope AS scope",
        {},
      );

      for (const row of allScopesRows) {
        const r = row as Record<string, unknown>;
        const scope = r.scope as string;
        if (scope && !validScopes.has(scope)) {
          findings.push({
            severity: "P0",
            category: "correctness",
            description: `Knowledge triple has invalid scope value: '${scope}' (expected: agent, team, or global)`,
            recommendation: "Audit EntityExtractor and ScopePromoter to ensure only valid scope values are written",
          });
        }
      }
    } catch {
      // Non-critical: scope check failure
    }
  }
}

/**
 * Convenience function for CLI usage: opens a MemoryEngine at the given
 * directory, runs gap analysis, closes the engine, and returns the report.
 */
export async function runGapAnalysis(memoryDir: string): Promise<GapReport> {
  const engine = new MemoryEngine(memoryDir);
  try {
    const analyzer = new GapAnalyzer(engine);
    return await analyzer.analyze();
  } finally {
    await engine.close();
  }
}
