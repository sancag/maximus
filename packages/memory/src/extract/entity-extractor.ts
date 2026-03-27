import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
	Episode,
	KnowledgeEntity,
	KnowledgeTriple,
} from "@maximus/shared";
import type { KnowledgeStore } from "../kuzu/knowledge-store.js";

/**
 * Function signature for LLM calls. Accepts a prompt, returns raw text.
 * Injected to avoid coupling @maximus/memory to any SDK.
 */
export type LlmFn = (prompt: string) => Promise<string>;

/**
 * Result of entity extraction from episodes.
 */
export interface ExtractionResult {
	entities: KnowledgeEntity[];
	triples: KnowledgeTriple[];
}

interface RawEntity {
	name: string;
	type: string;
	attributes?: Record<string, unknown>;
}

interface RawRelationship {
	source: string;
	predicate: string;
	target: string;
	confidence: number;
	agentName?: string;
}

interface ParsedResponse {
	entities: RawEntity[];
	relationships: RawRelationship[];
}

/**
 * EntityExtractor uses an injected LLM function to extract structured
 * entities and relationships from agent episodes, then persists them
 * in the knowledge graph via KnowledgeStore.
 */
export class EntityExtractor {
	constructor(
		private knowledgeStore: KnowledgeStore,
		private llm: LlmFn,
		private db?: Database.Database,
	) {}

	/**
	 * Get or create a prompt version record based on sha256 hash of prompt text.
	 * Returns the version ID. Returns "unknown" if no db is available.
	 */
	private getOrCreatePromptVersion(promptText: string): string {
		if (!this.db) return "unknown";

		const hash = createHash("sha256")
			.update(promptText)
			.digest("hex")
			.slice(0, 16);

		const existing = this.db
			.prepare("SELECT id FROM prompt_versions WHERE promptHash = ?")
			.get(hash) as { id: string } | undefined;

		if (existing) return existing.id;

		const id = nanoid();
		this.db
			.prepare(
				"INSERT INTO prompt_versions (id, promptHash, promptText, createdAt) VALUES (?, ?, ?, ?)",
			)
			.run(id, hash, promptText, Date.now());

		return id;
	}

	/**
	 * Record extraction quality metrics for a prompt version.
	 */
	private recordExtractionMetrics(
		promptVersionId: string,
		episodesProcessed: number,
		result: ExtractionResult,
	): void {
		if (!this.db || promptVersionId === "unknown") return;

		const entitiesPerEpisode =
			episodesProcessed > 0
				? result.entities.length / episodesProcessed
				: 0;
		const triplesPerEpisode =
			episodesProcessed > 0
				? result.triples.length / episodesProcessed
				: 0;

		// Unique entity ratio: unique names / total entities (higher = less duplication)
		const uniqueNames = new Set(result.entities.map((e) => e.name));
		const uniqueEntityRatio =
			result.entities.length > 0
				? uniqueNames.size / result.entities.length
				: 1;

		this.db
			.prepare(
				`INSERT INTO extraction_metrics (id, promptVersionId, timestamp, episodesProcessed, entitiesExtracted, triplesExtracted, uniqueEntityRatio, entitiesPerEpisode, triplesPerEpisode)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				nanoid(),
				promptVersionId,
				Date.now(),
				episodesProcessed,
				result.entities.length,
				result.triples.length,
				uniqueEntityRatio,
				entitiesPerEpisode,
				triplesPerEpisode,
			);
	}

	/**
	 * Extract entities and triples from a batch of episodes.
	 * Calls the LLM to identify entities/relationships, then stores them.
	 */
	async extractFromEpisodes(
		episodes: Episode[],
	): Promise<ExtractionResult> {
		if (episodes.length === 0) {
			return { entities: [], triples: [] };
		}

		const prompt = this.buildPrompt(episodes);
		const promptVersionId = this.getOrCreatePromptVersion(prompt);
		const raw = await this.llm(prompt);
		const parsed = this.parseResponse(raw);

		if (
			parsed.entities.length === 0 &&
			parsed.relationships.length === 0
		) {
			return { entities: [], triples: [] };
		}

		const now = Date.now();
		const knownAgents = new Set(episodes.map((e) => e.agentName));
		const fallbackAgent = episodes[0].agentName;

		// Build entities with generated IDs — deduplicated across agents
		const entityMap = new Map<string, KnowledgeEntity>();
		const entities: KnowledgeEntity[] = [];

		for (const rawEntity of parsed.entities) {
			if (!rawEntity.name || !rawEntity.type) continue;

			const entity: KnowledgeEntity = {
				id: nanoid(),
				name: rawEntity.name,
				type: rawEntity.type,
				attributes: rawEntity.attributes,
				createdBy: fallbackAgent,
				firstSeen: now,
				lastUpdated: now,
			};
			entityMap.set(rawEntity.name, entity);
			entities.push(entity);
		}

		// Build triples — each tagged to the discovering agent
		const triples: KnowledgeTriple[] = [];

		for (const rel of parsed.relationships) {
			if (!rel.source || !rel.predicate || !rel.target) continue;

			const sourceEntity = entityMap.get(rel.source);
			const targetEntity = entityMap.get(rel.target);
			if (!sourceEntity || !targetEntity) continue;

			// Use LLM-tagged agentName; fall back to first agent if missing/unknown
			const createdBy =
				rel.agentName && knownAgents.has(rel.agentName)
					? rel.agentName
					: fallbackAgent;

			const triple: KnowledgeTriple = {
				sourceId: sourceEntity.id,
				targetId: targetEntity.id,
				predicate: rel.predicate,
				scope: "agent",
				validFrom: now,
				confidence: typeof rel.confidence === "number" ? rel.confidence : 0.5,
				evidence: `Extracted from episodes: ${episodes.map((e) => e.id).join(", ")}`,
				createdBy,
			};
			triples.push(triple);
		}

		// Persist to knowledge store
		for (const entity of entities) {
			await this.knowledgeStore.upsertEntity(entity);
		}
		for (const triple of triples) {
			await this.knowledgeStore.insertTripleWithSupersession(triple);
		}

		// Record extraction quality metrics
		this.recordExtractionMetrics(promptVersionId, episodes.length, {
			entities,
			triples,
		});

		return { entities, triples };
	}

	/**
	 * Build the extraction prompt from episodes.
	 */
	buildPrompt(episodes: Episode[]): string {
		const episodesJson = JSON.stringify(
			episodes.map((e) => ({
				agentName: e.agentName,
				task: e.taskDescription,
				outcome: e.outcome,
				lessons: e.lessonsLearned,
				strategies: e.effectiveStrategies,
				failures: e.failurePatterns,
				tools: e.toolsUsed,
			})),
			null,
			2,
		);

		return `Extract OPERATIONAL KNOWLEDGE from these agent experience episodes. Focus on information that would help an agent perform BETTER next time, not facts that are obvious from the agent definition.

EXAMPLES OF BAD EXTRACTIONS (do NOT produce these):
- "hl-strategist" --[uses]--> "Efficient task completion" (too generic, obvious)
- "agent-name" --[is]--> "risk_manager" (just restating the agent definition)

EXAMPLES OF GOOD EXTRACTIONS:
- "SUPER perpetual" --[has_typical_spread]--> "0.13%" (confidence: 0.8) — operational fact useful for trading decisions
- "place_order" --[requires_before]--> "set_leverage" (confidence: 0.9) — ordering dependency discovered from failures
- "bulk_upload" --[recommended_for]--> "campaigns with >50 leads" (confidence: 0.7) — efficiency pattern

If the agent discovered an effective approach or workflow pattern, extract it as a "strategy" entity with a descriptive name (e.g., "set-leverage-before-orders") and link it with "discovered_by" to the agent.

Confidence guidance:
- 0.9 for facts directly confirmed by tool results
- 0.7 for patterns observed across multiple episodes
- 0.5 for inferences

Return ONLY valid JSON with this exact structure:
{
  "entities": [
    { "name": "string", "type": "string", "attributes": {} }
  ],
  "relationships": [
    { "source": "entity name", "predicate": "verb phrase", "target": "entity name", "confidence": 0.0-1.0, "agentName": "the agentName from the episode that discovered this relationship" }
  ]
}

Entity types: tool, api, parameter, error_pattern, strategy, concept, or a domain-specific type.
Predicates should be short verb phrases: "uses", "depends_on", "failed_with", "requires_before", "discovered_by", "recommended_for", "has_typical_spread".
Only extract entities and relationships that represent reusable operational knowledge, not one-time events.
Deduplicate entities across agents — if multiple agents mention the same concept, produce one entity.
If multiple agents discovered the same relationship, output it once per agent with the correct agentName.

Episodes:
${episodesJson}

JSON:`;
	}

	/**
	 * Parse the LLM response, handling raw JSON and markdown-fenced JSON.
	 * Returns empty result on parse failure (never throws).
	 */
	private parseResponse(raw: string): ParsedResponse {
		const empty: ParsedResponse = { entities: [], relationships: [] };

		// Try direct parse
		try {
			const parsed = JSON.parse(raw.trim());
			if (parsed && typeof parsed === "object") {
				return {
					entities: Array.isArray(parsed.entities)
						? parsed.entities
						: [],
					relationships: Array.isArray(parsed.relationships)
						? parsed.relationships
						: [],
				};
			}
		} catch {
			// Try stripping markdown fences
		}

		// Strip markdown code fences and retry
		try {
			const stripped = raw
				.replace(/^```(?:json)?\n?/m, "")
				.replace(/\n?```$/m, "")
				.trim();
			const parsed = JSON.parse(stripped);
			if (parsed && typeof parsed === "object") {
				return {
					entities: Array.isArray(parsed.entities)
						? parsed.entities
						: [],
					relationships: Array.isArray(parsed.relationships)
						? parsed.relationships
						: [],
				};
			}
		} catch {
			// Give up
		}

		return empty;
	}
}
