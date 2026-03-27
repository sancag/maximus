import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import type { MemoryEngine } from "@maximus/memory";
import { KnowledgeStore, EpisodeStore, BriefingStore, MetricsTracker } from "@maximus/memory";
import type { MemoryStatusResponse, KnowledgeGraphResponse, AgentMemoryResponse, PromoteRequest, PromoteResponse, PipelineResult } from "@maximus/shared";

export interface MemoryRoutesDeps {
	tracesDir?: string;
	runPipeline?: () => Promise<PipelineResult>;
}

export function memoryRoutes(engine: MemoryEngine, deps?: MemoryRoutesDeps): Router {
	const router = Router();

	// GET /api/memory/status
	router.get("/status", async (_req, res) => {
		try {
			const kuzu = await engine.getKuzu();
			const sqlite = engine.getSqlite();

			// Query entity count
			const entityResult = await kuzu.executePrepared(
				"MATCH (e:Entity) RETURN count(e) AS cnt",
				{},
			);
			const entityCount = Number((entityResult[0] as { cnt: bigint })?.cnt ?? 0);

			// Query active triple count by scope
			const tripleResult = await kuzu.executePrepared(
				"MATCH ()-[r:Related]->() WHERE r.validTo = 0 RETURN r.scope AS scope, count(r) AS cnt",
				{},
			);
			const scopeCounts = { agent: 0, team: 0, global: 0 };
			let tripleCount = 0;
			for (const row of tripleResult as Array<{ scope: string; cnt: bigint }>) {
				const count = Number(row.cnt);
				tripleCount += count;
				if (row.scope === "agent" || row.scope === "team" || row.scope === "global") {
					scopeCounts[row.scope] = count;
				}
			}

			// Query episode counts by agent
			const byAgentRows = sqlite.raw
				.prepare("SELECT agentName, COUNT(*) as count FROM episodes GROUP BY agentName")
				.all() as Array<{ agentName: string; count: number }>;

			// Query total episodes
			const totalRow = sqlite.raw
				.prepare("SELECT COUNT(*) as total FROM episodes")
				.get() as { total: number } | undefined;

			// Query last consolidation timestamp
			let lastConsolidation: number | null = null;
			try {
				const lastRow = sqlite.raw
					.prepare("SELECT MAX(processedAt) as last FROM processed_traces")
					.get() as { last: number | null } | undefined;
				lastConsolidation = lastRow?.last ?? null;
			} catch {
				// processed_traces table may not exist yet
				lastConsolidation = null;
			}

			const response: MemoryStatusResponse = {
				graph: {
					entityCount,
					tripleCount,
					scopeCounts,
				},
				episodes: {
					total: totalRow?.total ?? 0,
					byAgent: byAgentRows.map((r) => ({ agentName: r.agentName, count: r.count })),
				},
				lastConsolidation,
			};

			res.json(response);
		} catch (err) {
			// Return graceful empty response if databases don't exist yet
			const response: MemoryStatusResponse = {
				graph: {
					entityCount: 0,
					tripleCount: 0,
					scopeCounts: { agent: 0, team: 0, global: 0 },
				},
				episodes: {
					total: 0,
					byAgent: [],
				},
				lastConsolidation: null,
			};
			res.json(response);
		}
	});

	// GET /api/memory/graph?scope=agent|team|global|all
	router.get("/graph", async (req, res) => {
		try {
			const kuzu = await engine.getKuzu();
			const scope = (req.query.scope as string) || "all";

			// Query all entities (limit to 500 for performance)
			const entityResult = await kuzu.executePrepared(
				"MATCH (e:Entity) RETURN e LIMIT 500",
				{},
			);

			const nodes = (entityResult as Array<{ e: Record<string, unknown> }>).map((row) => ({
				id: String(row.e.id),
				name: String(row.e.name),
				type: String(row.e.type),
				createdBy: String(row.e.createdBy),
			}));

			// Query active triples, optionally filtered by scope
			let tripleQuery: string;
			let tripleParams: Record<string, string> = {};

			if (scope === "all") {
				tripleQuery = `MATCH (s:Entity)-[r:Related]->(t:Entity)
					WHERE r.validTo = 0
					RETURN s.id AS source, t.id AS target, r.predicate AS predicate, r.scope AS scope, r.confidence AS confidence`;
			} else {
				tripleQuery = `MATCH (s:Entity)-[r:Related]->(t:Entity)
					WHERE r.validTo = 0 AND r.scope = $scope
					RETURN s.id AS source, t.id AS target, r.predicate AS predicate, r.scope AS scope, r.confidence AS confidence`;
				tripleParams = { scope };
			}

			const tripleResult = await kuzu.executePrepared(tripleQuery, tripleParams);

			const links = (tripleResult as Array<{
				source: string;
				target: string;
				predicate: string;
				scope: string;
				confidence: number;
			}>).map((row) => ({
				source: row.source,
				target: row.target,
				predicate: row.predicate,
				scope: row.scope as "agent" | "team" | "global",
				confidence: Number(row.confidence),
			}));

			const response: KnowledgeGraphResponse = {
				nodes,
				links,
				counts: {
					entities: nodes.length,
					triples: links.length,
				},
			};

			res.json(response);
		} catch (err) {
			// Return graceful empty response if database doesn't exist yet
			const response: KnowledgeGraphResponse = {
				nodes: [],
				links: [],
				counts: {
					entities: 0,
					triples: 0,
				},
			};
			res.json(response);
		}
	});

	// GET /api/memory/inspect/:agent
	router.get("/inspect/:agent", async (req, res) => {
		try {
			const agentName = req.params.agent;
			const kuzu = await engine.getKuzu();
			const sqlite = engine.getSqlite();

			// Create stores
			const episodeStore = new EpisodeStore(sqlite.raw);
			const briefingStore = new BriefingStore(sqlite.raw);
			const metricsTracker = new MetricsTracker(sqlite.raw);
			const knowledgeStore = await KnowledgeStore.create(kuzu);

			// Get episodes (top 20 recent)
			const episodes = episodeStore.getByAgent(agentName, 20);

			// Get briefing
			const briefing = briefingStore.get(agentName);

			// Get knowledge via scope chain
			const knowledge = await knowledgeStore.getByScope(agentName, []);

			// Get metrics
			const metrics = metricsTracker.getByAgent(agentName);

			const response: AgentMemoryResponse = {
				agent: agentName,
				episodes,
				briefing,
				knowledge,
				metrics,
			};

			res.json(response);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			res.status(500).json({ error: message });
		}
	});

	// POST /api/memory/promote
	router.post("/promote", async (req, res) => {
		try {
			const { sourceId, predicate, targetId } = req.body as PromoteRequest;

			// Validate required fields
			if (!sourceId || !predicate || !targetId) {
				res.status(400).json({
					promoted: false,
					from: "unknown",
					to: "unknown",
					message: "Missing required fields: sourceId, predicate, targetId",
				} as PromoteResponse);
				return;
			}

			const kuzu = await engine.getKuzu();

			// Find the active triple and its current scope
			const tripleResult = await kuzu.executePrepared(
				`MATCH (s:Entity {id: $sourceId})-[r:Related]->(t:Entity {id: $targetId})
				 WHERE r.predicate = $predicate AND r.validTo = 0
				 RETURN r.scope AS scope, r.confidence AS confidence, r.evidence AS evidence, r.validFrom AS validFrom`,
				{ sourceId, targetId, predicate },
			);

			if (tripleResult.length === 0) {
				res.status(404).json({
					promoted: false,
					from: "unknown",
					to: "unknown",
					message: "No active triple found",
				} as PromoteResponse);
				return;
			}

			const row = tripleResult[0] as {
				scope: string;
				confidence: number;
				evidence: string;
				validFrom: number;
			};

			const currentScope = row.scope;

			// Check if already at global scope
			if (currentScope === "global") {
				res.status(400).json({
					promoted: false,
					from: "global",
					to: "global",
					message: "Already at global scope",
				} as PromoteResponse);
				return;
			}

			// Determine next scope
			const nextScope = currentScope === "agent" ? "team" : "global";

			// Create new triple at next scope
			await kuzu.executePrepared(
				`MATCH (s:Entity {id: $sourceId}), (t:Entity {id: $targetId})
				 CREATE (s)-[:Related {
					predicate: $predicate,
					scope: $nextScope,
					validFrom: $validFrom,
					validTo: 0,
					confidence: $confidence,
					evidence: $evidence,
					createdBy: $createdBy
				 }]->(t)`,
				{
					sourceId,
					targetId,
					predicate,
					nextScope,
					validFrom: Date.now(),
					confidence: row.confidence,
					evidence: row.evidence || "",
					createdBy: "system:manual-promotion",
				},
			);

			const response: PromoteResponse = {
				promoted: true,
				from: currentScope,
				to: nextScope,
				message: `Promoted from ${currentScope} to ${nextScope}`,
			};

			res.json(response);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			res.status(500).json({ error: message });
		}
	});

	// POST /api/memory/re-extract
	router.post("/re-extract", async (_req, res) => {
		try {
			const sqlite = engine.getSqlite();

			// Flush processed_traces so pipeline reprocesses all traces
			sqlite.raw.prepare("DELETE FROM processed_traces").run();
			// Flush episodes
			sqlite.raw.prepare("DELETE FROM episodes").run();
			// Flush agent_metrics
			sqlite.raw.prepare("DELETE FROM agent_metrics").run();
			// Flush briefings
			sqlite.raw.prepare("DELETE FROM briefings").run();

			// Flush Kuzu entities and triples
			try {
				const kuzu = await engine.getKuzu();
				await kuzu.executePrepared("MATCH ()-[r:Related]->() DELETE r", {});
				await kuzu.executePrepared("MATCH (e:Entity) DELETE e", {});
			} catch {
				// Kuzu may not be initialized yet — skip
			}

			// Re-run pipeline if available
			let pipelineResult: PipelineResult | undefined;
			if (deps?.runPipeline) {
				pipelineResult = await deps.runPipeline();
			}

			res.json({ success: true, result: pipelineResult });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			res.status(500).json({ success: false, error: message });
		}
	});

	// POST /api/memory/reset
	router.post("/reset", async (_req, res) => {
		try {
			const sqlite = engine.getSqlite();

			// Flush all SQLite tables
			sqlite.raw.prepare("DELETE FROM processed_traces").run();
			sqlite.raw.prepare("DELETE FROM episodes").run();
			sqlite.raw.prepare("DELETE FROM agent_metrics").run();
			sqlite.raw.prepare("DELETE FROM briefings").run();

			// Flush Kuzu entities and triples
			try {
				const kuzu = await engine.getKuzu();
				await kuzu.executePrepared("MATCH ()-[r:Related]->() DELETE r", {});
				await kuzu.executePrepared("MATCH (e:Entity) DELETE e", {});
			} catch {
				// Kuzu may not be initialized yet — skip
			}

			// Delete all trace files
			if (deps?.tracesDir) {
				try {
					const files = readdirSync(deps.tracesDir).filter((f) => f.endsWith(".jsonl"));
					for (const file of files) {
						try {
							unlinkSync(join(deps.tracesDir, file));
						} catch {
							// Individual file deletion failure — continue
						}
					}
				} catch {
					// tracesDir may not exist — skip
				}
			}

			res.json({ success: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			res.status(500).json({ success: false, error: message });
		}
	});

	return router;
}
