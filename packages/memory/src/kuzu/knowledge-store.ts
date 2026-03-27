import type { KnowledgeEntity, KnowledgeTriple } from "@maximus/shared";
import type { KuzuClient } from "./client.js";

export interface ScopeChainResult {
	entity: KnowledgeEntity;
	triple: KnowledgeTriple;
	target: KnowledgeEntity;
}

/**
 * KnowledgeStore provides entity/triple CRUD operations over the Kuzu graph,
 * with scope-chain queries and temporal supersession.
 *
 * Uses validTo=0 as sentinel for "currently active" (Kuzu INT64 cannot be null on REL).
 * Entity attributes are stored as JSON strings.
 */
export class KnowledgeStore {
	private constructor(private kuzu: KuzuClient) {}

	/**
	 * Create a KnowledgeStore with optional schema migration.
	 * Adds retrievalCount column to Entity if not present.
	 */
	static async create(kuzu: KuzuClient): Promise<KnowledgeStore> {
		try {
			await kuzu.query(
				"ALTER TABLE Entity ADD retrievalCount INT64 DEFAULT 0",
			);
		} catch {
			// Column may already exist — safe to ignore
		}
		return new KnowledgeStore(kuzu);
	}

	/**
	 * Create or update an entity. On update, preserves firstSeen.
	 */
	async upsertEntity(entity: KnowledgeEntity): Promise<void> {
		const attrs = entity.attributes
			? JSON.stringify(entity.attributes)
			: "{}";

		// Check if entity exists
		const existing = await this.kuzu.executePrepared(
			"MATCH (e:Entity {id: $id}) RETURN e.firstSeen AS firstSeen",
			{ id: entity.id },
		);

		if (existing.length > 0) {
			// Update — preserve firstSeen
			await this.kuzu.executePrepared(
				`MATCH (e:Entity {id: $id})
				 SET e.name = $name, e.type = $type, e.attributes = $attrs,
				     e.createdBy = $createdBy, e.lastUpdated = $lastUpdated`,
				{
					id: entity.id,
					name: entity.name,
					type: entity.type,
					attrs,
					createdBy: entity.createdBy,
					lastUpdated: entity.lastUpdated,
				},
			);
		} else {
			// Create
			await this.kuzu.executePrepared(
				`CREATE (e:Entity {
					id: $id, name: $name, type: $type, attributes: $attrs,
					createdBy: $createdBy, firstSeen: $firstSeen, lastUpdated: $lastUpdated
				})`,
				{
					id: entity.id,
					name: entity.name,
					type: entity.type,
					attrs,
					createdBy: entity.createdBy,
					firstSeen: entity.firstSeen,
					lastUpdated: entity.lastUpdated,
				},
			);
		}
	}

	/**
	 * Retrieve an entity by ID, or null if not found.
	 */
	async getEntity(id: string): Promise<KnowledgeEntity | null> {
		const rows = await this.kuzu.executePrepared(
			"MATCH (e:Entity {id: $id}) RETURN e",
			{ id },
		);
		if (rows.length === 0) return null;
		return this.parseEntityRow(rows[0]);
	}

	/**
	 * Get all entities created by a specific agent.
	 */
	async getEntitiesByCreator(
		createdBy: string,
	): Promise<KnowledgeEntity[]> {
		const rows = await this.kuzu.executePrepared(
			"MATCH (e:Entity) WHERE e.createdBy = $createdBy RETURN e",
			{ createdBy },
		);
		return rows.map((row) => this.parseEntityRow(row));
	}

	/**
	 * Insert a triple (Related edge) between two entities.
	 * Uses validTo=0 as sentinel for "currently active".
	 */
	async insertTriple(triple: KnowledgeTriple): Promise<void> {
		await this.kuzu.executePrepared(
			`MATCH (s:Entity {id: $sourceId}), (t:Entity {id: $targetId})
			 CREATE (s)-[:Related {
				predicate: $predicate,
				scope: $scope,
				validFrom: $validFrom,
				validTo: $validTo,
				confidence: $confidence,
				evidence: $evidence,
				createdBy: $createdBy
			 }]->(t)`,
			{
				sourceId: triple.sourceId,
				targetId: triple.targetId,
				predicate: triple.predicate,
				scope: triple.scope,
				validFrom: triple.validFrom,
				validTo: 0, // sentinel for active
				confidence: triple.confidence,
				evidence: triple.evidence ?? "",
				createdBy: triple.createdBy,
			},
		);
	}

	/**
	 * Check if an active triple exists with given source+predicate+target+createdBy.
	 * Scoped to createdBy so each agent maintains an independent knowledge timeline.
	 */
	async findActiveTriple(
		sourceId: string,
		predicate: string,
		targetId: string,
		createdBy?: string,
	): Promise<boolean> {
		const rows = await this.kuzu.executePrepared(
			`MATCH (s:Entity {id: $sourceId})-[r:Related]->(t:Entity {id: $targetId})
			 WHERE r.predicate = $predicate AND r.validTo = 0
			 AND ($createdBy = '' OR r.createdBy = $createdBy)
			 RETURN r`,
			{ sourceId, targetId, predicate, createdBy: createdBy ?? "" },
		);
		return rows.length > 0;
	}

	/**
	 * Supersede an active triple by setting its validTo timestamp.
	 * Scoped to createdBy so only the same agent's prior triple is retired.
	 */
	async supersede(
		sourceId: string,
		predicate: string,
		targetId: string,
		validTo: number,
		createdBy?: string,
	): Promise<void> {
		await this.kuzu.executePrepared(
			`MATCH (s:Entity {id: $sourceId})-[r:Related]->(t:Entity {id: $targetId})
			 WHERE r.predicate = $predicate AND r.validTo = 0
			 AND ($createdBy = '' OR r.createdBy = $createdBy)
			 SET r.validTo = $validTo`,
			{ sourceId, targetId, predicate, validTo, createdBy: createdBy ?? "" },
		);
	}

	/**
	 * Insert a triple with supersession: if an active triple with the same
	 * source+predicate+target+createdBy exists, retire it before inserting the new one.
	 * Each agent maintains its own independent knowledge timeline.
	 */
	async insertTripleWithSupersession(
		triple: KnowledgeTriple,
	): Promise<void> {
		const exists = await this.findActiveTriple(
			triple.sourceId,
			triple.predicate,
			triple.targetId,
			triple.createdBy,
		);
		if (exists) {
			await this.supersede(
				triple.sourceId,
				triple.predicate,
				triple.targetId,
				triple.validFrom,
				triple.createdBy,
			);
		}
		await this.insertTriple(triple);
	}

	/**
	 * Scope chain query: returns agent + team + global knowledge for an agent.
	 * Runs separate queries per scope level and merges results in TypeScript.
	 */
	async getByScope(
		agentName: string,
		teamMembers: string[],
	): Promise<ScopeChainResult[]> {
		const results: ScopeChainResult[] = [];

		// 1. Agent scope
		const agentRows = await this.kuzu.executePrepared(
			`MATCH (s:Entity)-[r:Related]->(t:Entity)
			 WHERE r.scope = 'agent' AND r.createdBy = $agentName AND r.validTo = 0
			 RETURN s, r, t`,
			{ agentName },
		);
		results.push(...agentRows.map((row) => this.parseScopeRow(row)));

		// 2. Team scope (skip if no team members — means no team context)
		if (teamMembers.length > 0) {
			const teamRows = await this.kuzu.executePrepared(
				`MATCH (s:Entity)-[r:Related]->(t:Entity)
				 WHERE r.scope = 'team' AND r.validTo = 0
				 RETURN s, r, t`,
				{},
			);
			results.push(...teamRows.map((row) => this.parseScopeRow(row)));
		}

		// 3. Global scope
		const globalRows = await this.kuzu.executePrepared(
			`MATCH (s:Entity)-[r:Related]->(t:Entity)
			 WHERE r.scope = 'global' AND r.validTo = 0
			 RETURN s, r, t`,
			{},
		);
		results.push(...globalRows.map((row) => this.parseScopeRow(row)));

		return results;
	}

	/**
	 * Increment retrieval count and update lastUpdated for an entity.
	 */
	async incrementRetrievalCount(entityId: string): Promise<void> {
		await this.kuzu.executePrepared(
			`MATCH (e:Entity {id: $id})
			 SET e.retrievalCount = e.retrievalCount + 1, e.lastUpdated = $now`,
			{ id: entityId, now: Date.now() },
		);
	}

	// --- Private helpers ---

	private parseEntityRow(row: unknown): KnowledgeEntity {
		const r = row as Record<string, unknown>;
		const e = r.e as Record<string, unknown> | undefined;
		const data = e ?? r;
		return {
			id: data.id as string,
			name: data.name as string,
			type: data.type as string,
			attributes: this.parseAttributes(data.attributes as string),
			createdBy: data.createdBy as string,
			firstSeen: Number(data.firstSeen),
			lastUpdated: Number(data.lastUpdated),
		};
	}

	private parseScopeRow(row: unknown): ScopeChainResult {
		const r = row as Record<string, unknown>;
		const s = r.s as Record<string, unknown>;
		const t = r.t as Record<string, unknown>;
		const rel = r.r as Record<string, unknown>;

		return {
			entity: {
				id: s.id as string,
				name: s.name as string,
				type: s.type as string,
				attributes: this.parseAttributes(s.attributes as string),
				createdBy: s.createdBy as string,
				firstSeen: Number(s.firstSeen),
				lastUpdated: Number(s.lastUpdated),
			},
			triple: {
				sourceId: s.id as string,
				targetId: t.id as string,
				predicate: rel.predicate as string,
				scope: rel.scope as "agent" | "team" | "global",
				validFrom: Number(rel.validFrom),
				validTo: Number(rel.validTo) || undefined,
				confidence: Number(rel.confidence),
				evidence: (rel.evidence as string) || undefined,
				createdBy: rel.createdBy as string,
			},
			target: {
				id: t.id as string,
				name: t.name as string,
				type: t.type as string,
				attributes: this.parseAttributes(t.attributes as string),
				createdBy: t.createdBy as string,
				firstSeen: Number(t.firstSeen),
				lastUpdated: Number(t.lastUpdated),
			},
		};
	}

	private parseAttributes(
		raw: string | null | undefined,
	): Record<string, unknown> | undefined {
		if (!raw || raw === "{}") return undefined;
		try {
			const parsed = JSON.parse(raw);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				Object.keys(parsed).length > 0
			) {
				return parsed;
			}
			return undefined;
		} catch {
			return undefined;
		}
	}
}
