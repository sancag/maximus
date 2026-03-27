import { join } from "node:path";
import { statSync, unlinkSync } from "node:fs";
import type {
	DeepSleepConfig,
	PipelineResult,
	AgentEvent,
	Episode,
} from "@maximus/shared";
import type { MemoryEngine } from "../engine.js";
import type { LlmFn } from "../extract/entity-extractor.js";
import { TraceReader } from "../trace/reader.js";
import { EpisodeDistiller } from "../trace/distiller.js";
import { EpisodeStore } from "../sqlite/episodes.js";
import { MetricsTracker } from "../sqlite/metrics.js";
import { EntityExtractor } from "../extract/entity-extractor.js";
import { KnowledgeStore } from "../kuzu/knowledge-store.js";
import { BriefingStore } from "../sqlite/briefing-store.js";
import { BriefingGenerator } from "../briefing/briefing-generator.js";
import { ScopePromoter } from "./scope-promoter.js";
import { StrategyRegistry } from "../sqlite/strategy-registry.js";

/**
 * DeepSleepPipeline orchestrates the full memory consolidation cycle.
 * Runs 6 stages in strict order:
 * 1. Scan & Distill traces into episodes
 * 2. Extract entities and triples from new episodes
 * 3. Promote scope (agent -> team -> global)
 * 4. Generate briefings for affected agents
 * 5. Prune stale triples, low-utility episodes, orphaned entities
 *
 * Each stage captures errors independently so subsequent stages still run.
 * Processed traces are tracked in SQLite to prevent reprocessing.
 */
export class DeepSleepPipeline {
	constructor(
		private engine: MemoryEngine,
		private llmFn: LlmFn,
		private tracesDir: string,
		private config: DeepSleepConfig,
		private agentResolver: () => Array<{ name: string; team?: string }>,
		private eventEmitter?: { emit: (event: AgentEvent) => void },
		private orchestratorName?: string,
	) {}

	/**
	 * Get trace IDs that have already been processed.
	 */
	private getProcessedTraceIds(): Set<string> {
		const db = this.engine.getSqlite().raw;
		const rows = db
			.prepare("SELECT traceId FROM processed_traces")
			.all() as Array<{ traceId: string }>;
		return new Set(rows.map((r) => r.traceId));
	}

	/**
	 * Record a trace as processed.
	 */
	private markTraceProcessed(
		traceId: string,
		episodeId: string | null,
	): void {
		const db = this.engine.getSqlite().raw;
		db.prepare(
			"INSERT OR IGNORE INTO processed_traces (traceId, processedAt, episodeId) VALUES (?, ?, ?)",
		).run(traceId, Date.now(), episodeId);
	}

	/**
	 * Build a map of team name -> member agent names from the agent resolver.
	 */
	private buildTeamMap(): Map<string, string[]> {
		const agents = this.agentResolver();
		const teamMap = new Map<string, string[]>();
		for (const agent of agents) {
			const team = agent.team ?? agent.name;
			if (!teamMap.has(team)) teamMap.set(team, []);
			teamMap.get(team)!.push(agent.name);
		}
		return teamMap;
	}

	/**
	 * Emit a pipeline event via the event emitter if one is provided.
	 */
	private emitPipelineEvent(
		type: string,
		payload: Record<string, unknown>,
	): void {
		if (!this.eventEmitter) return;
		this.eventEmitter.emit({
			id: `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			timestamp: Date.now(),
			sessionId: "deep-sleep",
			agentName: "system",
			type: type as AgentEvent["type"],
			payload,
		});
	}

	/**
	 * Run the full consolidation pipeline.
	 * Returns a PipelineResult with counts for each stage.
	 */
	async run(): Promise<PipelineResult> {
		const result: PipelineResult = {
			tracesProcessed: 0,
			episodesCreated: 0,
			entitiesExtracted: 0,
			triplesExtracted: 0,
			triplesPromoted: 0,
			briefingsGenerated: 0,
			metricsComputed: 0,
			triplesPruned: 0,
			episodesPruned: 0,
			entitiesPruned: 0,
			tracesPruned: 0,
			stageErrors: [],
		};

		this.emitPipelineEvent("pipeline:started", {});

		const teamMap = this.buildTeamMap();
		const newEpisodes: Episode[] = [];
		const affectedAgents = new Set<string>();

		// Stage 1: Scan & Distill
		try {
			const reader = new TraceReader(this.tracesDir);
			const episodeStore = new EpisodeStore(this.engine.getSqlite().raw);
			const distiller = new EpisodeDistiller(episodeStore);
			const processedIds = this.getProcessedTraceIds();
			const allTraceIds = reader.listTraceIds();
			const unprocessed = allTraceIds.filter(
				(id) => !processedIds.has(id),
			);

			for (const traceId of unprocessed) {
				try {
					const events = reader.readTrace(traceId);
					if (events.length === 0) {
						this.markTraceProcessed(traceId, null);
						result.tracesProcessed++;
						continue;
					}

					const agentName = events[0].agentName;
					const episode = distiller.distill(agentName, events);
					episodeStore.store(episode);
					this.markTraceProcessed(traceId, episode.id);
					newEpisodes.push(episode);
					affectedAgents.add(agentName);
					result.tracesProcessed++;
					result.episodesCreated++;
				} catch (err) {
					// Individual trace failure: mark and continue
					this.markTraceProcessed(traceId, null);
					result.tracesProcessed++;
				}
			}

			this.emitPipelineEvent("pipeline:stage-completed", {
				stage: "distill",
				tracesProcessed: result.tracesProcessed,
				episodesCreated: result.episodesCreated,
			});
		} catch (err) {
			result.stageErrors.push({
				stage: "distill",
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Stage 1.5: Metrics Computation
		try {
			if (affectedAgents.size > 0) {
				const metricsTracker = new MetricsTracker(this.engine.getSqlite().raw);
				const now = Date.now();
				const windowStart = now - 7 * 86_400_000; // 7-day window

				for (const agentName of affectedAgents) {
					metricsTracker.computeAndStore(agentName, windowStart, now);
					result.metricsComputed++;
				}
			}

			this.emitPipelineEvent("pipeline:stage-completed", {
				stage: "metrics",
				metricsComputed: result.metricsComputed,
			});
		} catch (err) {
			result.stageErrors.push({
				stage: "metrics",
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Stage 1.6: Strategy Registry Population
		try {
			if (newEpisodes.length > 0) {
				const strategyRegistry = new StrategyRegistry(this.engine.getSqlite().raw);
				for (const episode of newEpisodes) {
					for (const strategy of episode.effectiveStrategies) {
						strategyRegistry.record(episode.agentName, strategy, episode.outcome);
					}
				}
			}

			this.emitPipelineEvent("pipeline:stage-completed", {
				stage: "strategy-registry",
			});
		} catch (err) {
			result.stageErrors.push({
				stage: "strategy-registry",
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Stage 2: Entity Extraction
		try {
			if (newEpisodes.length > 0) {
				const kuzu = await this.engine.getKuzu();
				const knowledgeStore = await KnowledgeStore.create(kuzu);
				const extractor = new EntityExtractor(knowledgeStore, this.llmFn, this.engine.getSqlite().raw);

				// Single batch — LLM deduplicates entities across agents and tags each relationship
				// with the discovering agent. One call regardless of how many agents have new episodes.
				const extraction = await extractor.extractFromEpisodes(newEpisodes);
				result.entitiesExtracted += extraction.entities.length;
				result.triplesExtracted += extraction.triples.length;
			}

			this.emitPipelineEvent("pipeline:stage-completed", {
				stage: "extract",
				entitiesExtracted: result.entitiesExtracted,
				triplesExtracted: result.triplesExtracted,
			});
		} catch (err) {
			result.stageErrors.push({
				stage: "extract",
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Stage 3: Scope Promotion
		try {
			const kuzu = await this.engine.getKuzu();
			// Ensure retrievalCount column exists (migration via KnowledgeStore.create)
			await KnowledgeStore.create(kuzu);
			const metricsTracker = new MetricsTracker(this.engine.getSqlite().raw);
			const promoter = new ScopePromoter(kuzu, this.config, metricsTracker);
			result.triplesPromoted = await promoter.runAll(
				teamMap,
				this.orchestratorName,
			);

			this.emitPipelineEvent("pipeline:stage-completed", {
				stage: "promote",
				triplesPromoted: result.triplesPromoted,
			});
		} catch (err) {
			result.stageErrors.push({
				stage: "promote",
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Stage 4: Briefing Generation
		try {
			const briefingStore = new BriefingStore(this.engine.getSqlite().raw);
			const episodeStore = new EpisodeStore(this.engine.getSqlite().raw);
			const kuzu = await this.engine.getKuzu();
			const knowledgeStore = await KnowledgeStore.create(kuzu);
			const metricsTracker = new MetricsTracker(this.engine.getSqlite().raw);
			const strategyRegistry = new StrategyRegistry(this.engine.getSqlite().raw);
			const generator = new BriefingGenerator(
				episodeStore,
				knowledgeStore,
				briefingStore,
				metricsTracker,
				strategyRegistry,
			);

			// Invalidate briefings for affected agents
			for (const agentName of affectedAgents) {
				briefingStore.invalidate(agentName);
			}

			// Generate briefings for agents with invalidated briefings
			const agents = this.agentResolver();
			for (const agent of agents) {
				if (!affectedAgents.has(agent.name)) continue;

				const teamMembers = (
					teamMap.get(agent.team ?? agent.name) ?? []
				).filter((m) => m !== agent.name);

				const briefing = await generator.generate(
					agent.name,
					teamMembers,
				);
				if (briefing) {
					result.briefingsGenerated++;
				}
			}

			this.emitPipelineEvent("pipeline:stage-completed", {
				stage: "briefings",
				briefingsGenerated: result.briefingsGenerated,
			});
		} catch (err) {
			result.stageErrors.push({
				stage: "briefings",
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Stage 5: Pruning
		try {
			// Prune stale triples (validTo > 0 and older than threshold)
			try {
				const kuzu = await this.engine.getKuzu();
				const cutoff =
					Date.now() - this.config.staleTripleDays * 86_400_000;

				// Kuzu may not support DELETE...RETURN count, so query first then delete
				const staleTriples = await kuzu.executePrepared(
					`MATCH (s:Entity)-[r:Related]->(t:Entity) WHERE r.validTo > 0 AND r.validTo < $cutoff RETURN s.id AS sid, t.id AS tid, r.predicate AS pred`,
					{ cutoff },
				);

				for (const row of staleTriples) {
					const r = row as Record<string, unknown>;
					await kuzu.executePrepared(
						`MATCH (s:Entity {id: $sid})-[r:Related {predicate: $pred}]->(t:Entity {id: $tid}) WHERE r.validTo > 0 AND r.validTo < $cutoff DELETE r`,
						{
							sid: r.sid as string,
							tid: r.tid as string,
							pred: r.pred as string,
							cutoff,
						},
					);
				}
				result.triplesPruned = staleTriples.length;
			} catch {
				// Kuzu pruning failure is non-critical
			}

			// Prune low-utility episodes
			try {
				const db = this.engine.getSqlite().raw;
				const ageCutoff =
					Date.now() -
					this.config.lowUtilityMaxAge * 86_400_000;

				const pruneResult = db
					.prepare(
						`DELETE FROM episodes WHERE utilityScore < @minScore AND timestamp < @ageCutoff AND retrievalCount = 0`,
					)
					.run({
						minScore: this.config.lowUtilityMinScore,
						ageCutoff,
					});
				result.episodesPruned = pruneResult.changes;
			} catch {
				// SQLite pruning failure is non-critical
			}

			// Prune orphaned entities
			try {
				const kuzu = await this.engine.getKuzu();
				// Query orphaned entities first
				const orphans = await kuzu.executePrepared(
					`MATCH (e:Entity) WHERE NOT EXISTS { MATCH (e)-[:Related]-() } AND NOT EXISTS { MATCH ()-[:Related]->(e) } RETURN e.id AS eid`,
					{},
				);

				for (const row of orphans) {
					const r = row as Record<string, unknown>;
					await kuzu.executePrepared(
						`MATCH (e:Entity {id: $eid}) DELETE e`,
						{ eid: r.eid as string },
					);
				}
				result.entitiesPruned = orphans.length;
			} catch {
				// Orphan pruning failure is non-critical
			}

			this.emitPipelineEvent("pipeline:stage-completed", {
				stage: "prune",
				triplesPruned: result.triplesPruned,
				episodesPruned: result.episodesPruned,
				entitiesPruned: result.entitiesPruned,
			});
		} catch (err) {
			result.stageErrors.push({
				stage: "prune",
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Stage 6: Trace File Pruning
		try {
			const maxAgeDays = this.config.maxTraceAgeDays ?? 30;
			const cutoffMs = Date.now() - maxAgeDays * 86_400_000;
			const reader = new TraceReader(this.tracesDir);
			const processedIds = this.getProcessedTraceIds();
			const allTraceIds = reader.listTraceIds();
			let pruned = 0;

			for (const traceId of allTraceIds) {
				// Only prune traces that have been processed (safety: never delete unprocessed)
				if (!processedIds.has(traceId)) continue;

				const traceFile = join(this.tracesDir, `${traceId}.jsonl`);
				try {
					const stat = statSync(traceFile);
					if (stat.mtimeMs < cutoffMs) {
						unlinkSync(traceFile);
						pruned++;
					}
				} catch {
					// File may not exist or be unreadable — skip
				}
			}
			result.tracesPruned = pruned;

			this.emitPipelineEvent("pipeline:stage-completed", {
				stage: "trace-prune",
				tracesPruned: pruned,
			});
		} catch (err) {
			result.stageErrors.push({
				stage: "trace-prune",
				error: err instanceof Error ? err.message : String(err),
			});
		}

		this.emitPipelineEvent("pipeline:completed", { result });

		return result;
	}
}
