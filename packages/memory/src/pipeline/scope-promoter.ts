import type { DeepSleepConfig } from "@maximus/shared";
import type { KuzuClient } from "../kuzu/client.js";
import type { MetricsTracker } from "../sqlite/metrics.js";

interface TripleRow {
	sourceId: string;
	sourceName: string;
	targetId: string;
	targetName: string;
	predicate: string;
	createdBy: string;
	confidence: number;
	evidence: string;
	validFrom: number;
	sourceRetrievalCount: number;
}

/**
 * ScopePromoter handles promotion of knowledge triples through scope levels:
 * agent -> team -> global.
 *
 * Promotion is copy-based: the original triple is preserved and a new triple
 * is created at the higher scope level with createdBy='system:promotion'.
 */
export class ScopePromoter {
	constructor(
		private kuzu: KuzuClient,
		private config: DeepSleepConfig,
		private metricsTracker?: MetricsTracker,
	) {}

	private normalize(name: string): string {
		return name.toLowerCase().trim().replace(/\s+/g, " ");
	}

	/**
	 * Check if an active triple already exists at the target scope.
	 */
	private async existsAtScope(
		sourceId: string,
		predicate: string,
		targetId: string,
		scope: string,
	): Promise<boolean> {
		const rows = await this.kuzu.executePrepared(
			`MATCH (s:Entity {id: $sourceId})-[r:Related {predicate: $predicate}]->(t:Entity {id: $targetId}) WHERE r.scope = $scope AND r.validTo = 0 RETURN count(r) AS cnt`,
			{ sourceId, predicate, targetId, scope },
		);
		if (rows.length === 0) return false;
		return Number((rows[0] as Record<string, unknown>).cnt) > 0;
	}

	/**
	 * Create a promoted triple at the given scope.
	 */
	private async createPromotedTriple(
		sourceId: string,
		targetId: string,
		predicate: string,
		scope: string,
		confidence: number,
		evidence: string,
		validFrom: number,
	): Promise<void> {
		await this.kuzu.executePrepared(
			`MATCH (s:Entity {id: $sourceId}), (t:Entity {id: $targetId}) CREATE (s)-[:Related {predicate: $predicate, scope: $scope, validFrom: $validFrom, validTo: 0, confidence: $confidence, evidence: $evidence, createdBy: $createdBy}]->(t)`,
			{
				sourceId,
				targetId,
				predicate,
				scope,
				validFrom,
				confidence,
				evidence,
				createdBy: "system:promotion",
			},
		);
	}

	/**
	 * Query all active triples at a given scope.
	 */
	private async getActiveTriples(scope: string): Promise<TripleRow[]> {
		const rows = await this.kuzu.executePrepared(
			`MATCH (s:Entity)-[r:Related]->(t:Entity) WHERE r.scope = $scope AND r.validTo = 0 RETURN s.id AS sourceId, s.name AS sourceName, t.id AS targetId, t.name AS targetName, r.predicate AS predicate, r.createdBy AS createdBy, r.confidence AS confidence, r.evidence AS evidence, r.validFrom AS validFrom, s.retrievalCount AS sourceRetrievalCount`,
			{ scope },
		);
		return rows.map((row) => {
			const r = row as Record<string, unknown>;
			return {
				sourceId: r.sourceId as string,
				sourceName: r.sourceName as string,
				targetId: r.targetId as string,
				targetName: r.targetName as string,
				predicate: r.predicate as string,
				createdBy: r.createdBy as string,
				confidence: Number(r.confidence),
				evidence: (r.evidence as string) || "",
				validFrom: Number(r.validFrom),
				sourceRetrievalCount: Number(r.sourceRetrievalCount) || 0,
			};
		});
	}

	/**
	 * Promote agent-scope triples to team scope when:
	 * - 2+ distinct agents within the same team share the same normalized (sourceName, predicate, targetName)
	 * - OR an entity's retrievalCount exceeds threshold with sufficient confidence
	 */
	async promoteAgentToTeam(
		teamMap: Map<string, string[]>,
	): Promise<number> {
		const triples = await this.getActiveTriples("agent");
		let promoted = 0;

		// Build a set of all team member names for quick lookup
		const agentToTeam = new Map<string, string>();
		for (const [teamName, members] of teamMap) {
			for (const member of members) {
				agentToTeam.set(member, teamName);
			}
		}

		// Group triples by normalized (sourceName, predicate, targetName) key
		type GroupEntry = { triple: TripleRow; team: string | undefined };
		const groups = new Map<string, GroupEntry[]>();

		for (const triple of triples) {
			const key = `${this.normalize(triple.sourceName)}|${triple.predicate}|${this.normalize(triple.targetName)}`;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push({
				triple,
				team: agentToTeam.get(triple.createdBy),
			});
		}

		for (const [, entries] of groups) {
			// Check multi-agent criterion: 2+ distinct agents in the same team
			const byTeam = new Map<string, Set<string>>();
			for (const entry of entries) {
				if (entry.team) {
					if (!byTeam.has(entry.team)) byTeam.set(entry.team, new Set());
					byTeam.get(entry.team)!.add(entry.triple.createdBy);
				}
			}

			let shouldPromote = false;

			// Check if any team has >= minAgents distinct agents
			for (const [, agents] of byTeam) {
				if (agents.size >= this.config.agentToTeamMinAgents) {
					shouldPromote = true;
					break;
				}
			}

			// Check retrieval count criterion with metric-driven threshold adjustment
			if (!shouldPromote) {
				for (const entry of entries) {
					// Adjust threshold based on agent success rate (META-08)
					let threshold = this.config.agentToTeamRetrievalCount;
					if (this.metricsTracker) {
						const metrics = this.metricsTracker.getLatest(entry.triple.createdBy);
						if (metrics?.successRate !== undefined) {
							if (metrics.successRate >= 0.8) {
								threshold = Math.max(1, Math.floor(threshold * 0.6)); // Promote faster
							} else if (metrics.successRate < 0.3) {
								continue; // Skip promotion for low-success agents
							}
						}
					}

					if (
						entry.triple.sourceRetrievalCount > threshold &&
						entry.triple.confidence >= this.config.agentToTeamMinConfidence
					) {
						shouldPromote = true;
						break;
					}
				}
			}

			if (shouldPromote) {
				// Pick the highest confidence triple as the representative
				const best = entries.reduce((a, b) =>
					a.triple.confidence >= b.triple.confidence ? a : b,
				);
				const t = best.triple;

				// Check if already promoted
				const exists = await this.existsAtScope(
					t.sourceId,
					t.predicate,
					t.targetId,
					"team",
				);
				if (!exists) {
					const teamName = best.team ?? "unknown";
					await this.createPromotedTriple(
						t.sourceId,
						t.targetId,
						t.predicate,
						"team",
						t.confidence,
						`team:${teamName}`,
						Date.now(),
					);
					promoted++;
				}
			}
		}

		// Strategy promotion (D-21): promote strategies discovered by 2+ agents to team scope
		try {
			const strategyEntities = await this.kuzu.executePrepared(
				`MATCH (a:Entity)-[r:Related {predicate: 'discovered_by', scope: 'agent'}]->(s:Entity {type: 'strategy'}) WHERE r.validTo = 0 RETURN s.id AS strategyId, s.name AS strategyName, collect(DISTINCT a.name) AS agents`,
				{},
			);

			for (const row of strategyEntities) {
				const r = row as Record<string, unknown>;
				const agents = r.agents as string[];
				if (agents.length >= 2) {
					// Find the source entity for promotion (first agent entity)
					const sourceRows = await this.kuzu.executePrepared(
						`MATCH (a:Entity)-[r:Related {predicate: 'discovered_by', scope: 'agent'}]->(s:Entity {id: $strategyId}) WHERE r.validTo = 0 RETURN a.id AS sourceId LIMIT 1`,
						{ strategyId: r.strategyId as string },
					);
					if (sourceRows.length > 0) {
						const sourceId = (sourceRows[0] as Record<string, unknown>).sourceId as string;
						const exists = await this.existsAtScope(
							sourceId,
							"discovered_by",
							r.strategyId as string,
							"team",
						);
						if (!exists) {
							await this.createPromotedTriple(
								sourceId,
								r.strategyId as string,
								"discovered_by",
								"team",
								0.9,
								`strategy:${r.strategyName as string}`,
								Date.now(),
							);
							promoted++;
						}
					}
				}
			}
		} catch {
			// Strategy promotion query failure is non-critical
		}

		return promoted;
	}

	/**
	 * Promote team-scope triples to global scope when:
	 * - The same triple appears in 2+ teams (by evidence tag)
	 * - OR retrievalCount > threshold with sufficient confidence
	 */
	async promoteTeamToGlobal(
		_teamMap: Map<string, string[]>,
	): Promise<number> {
		const triples = await this.getActiveTriples("team");
		let promoted = 0;

		// Group by normalized key
		const groups = new Map<string, TripleRow[]>();
		for (const triple of triples) {
			const key = `${this.normalize(triple.sourceName)}|${triple.predicate}|${this.normalize(triple.targetName)}`;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(triple);
		}

		for (const [, entries] of groups) {
			let shouldPromote = false;

			// Check multi-team criterion: count distinct team evidence tags only.
			// createdBy is always "system:promotion" for team triples so must not be counted.
			const teams = new Set<string>();
			for (const entry of entries) {
				if (entry.evidence.startsWith("team:")) {
					teams.add(entry.evidence);
				}
			}
			if (teams.size >= this.config.teamToGlobalMinTeams) {
				shouldPromote = true;
			}

			// Check retrieval count criterion
			if (!shouldPromote) {
				for (const entry of entries) {
					if (
						entry.sourceRetrievalCount > this.config.teamToGlobalRetrievalCount &&
						entry.confidence >= this.config.teamToGlobalMinConfidence
					) {
						shouldPromote = true;
						break;
					}
				}
			}

			if (shouldPromote) {
				const best = entries.reduce((a, b) =>
					a.confidence >= b.confidence ? a : b,
				);

				const exists = await this.existsAtScope(
					best.sourceId,
					best.predicate,
					best.targetId,
					"global",
				);
				if (!exists) {
					await this.createPromotedTriple(
						best.sourceId,
						best.targetId,
						best.predicate,
						"global",
						best.confidence,
						"promoted:team-to-global",
						Date.now(),
					);
					promoted++;
				}
			}
		}

		return promoted;
	}

	/**
	 * Auto-promote orchestrator agent triples directly to global scope.
	 * Per design decision D-07: orchestrator knowledge is global by nature.
	 */
	async promoteOrchestratorToGlobal(
		orchestratorName: string,
	): Promise<number> {
		const triples = await this.getActiveTriples("agent");
		let promoted = 0;

		for (const triple of triples) {
			if (triple.createdBy !== orchestratorName) continue;

			const exists = await this.existsAtScope(
				triple.sourceId,
				triple.predicate,
				triple.targetId,
				"global",
			);
			if (!exists) {
				await this.createPromotedTriple(
					triple.sourceId,
					triple.targetId,
					triple.predicate,
					"global",
					triple.confidence,
					"promoted:orchestrator",
					Date.now(),
				);
				promoted++;
			}
		}

		return promoted;
	}

	/**
	 * Run all promotion stages in order: agent->team, team->global, orchestrator->global.
	 * Returns total number of promoted triples.
	 */
	async runAll(
		teamMap: Map<string, string[]>,
		orchestratorName?: string,
	): Promise<number> {
		let total = 0;
		total += await this.promoteAgentToTeam(teamMap);
		total += await this.promoteTeamToGlobal(teamMap);
		if (orchestratorName) {
			total += await this.promoteOrchestratorToGlobal(orchestratorName);
		}
		return total;
	}
}
