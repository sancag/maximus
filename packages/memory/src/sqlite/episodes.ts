import type Database from "better-sqlite3";
import type { Episode } from "@maximus/shared";

/**
 * Row type as returned from SQLite (all array fields stored as JSON strings).
 */
interface EpisodeRow {
	id: string;
	agentName: string;
	timestamp: number;
	taskDescription: string;
	outcome: string;
	lessonsLearned: string;
	effectiveStrategies: string;
	failurePatterns: string;
	toolsUsed: string;
	turnCount: number | null;
	costUsd: number | null;
	durationMs: number | null;
	tags: string;
	utilityScore: number;
	retrievalCount: number;
}

/**
 * Persists and retrieves episodes in SQLite.
 * Handles JSON serialization of array fields and utility-based pruning.
 */
export class EpisodeStore {
	private insertStmt: Database.Statement;
	private getByAgentStmt: Database.Statement;
	private getByIdStmt: Database.Statement;
	private countByAgentStmt: Database.Statement;
	private pruneStmt: Database.Statement;
	private updateUtilityStmt: Database.Statement;
	private batchIncrementRetrievalStmt: Database.Statement;

	constructor(private db: Database.Database) {
		this.insertStmt = db.prepare(
			`INSERT INTO episodes (id, agentName, timestamp, taskDescription, outcome, lessonsLearned, effectiveStrategies, failurePatterns, toolsUsed, turnCount, costUsd, durationMs, tags, utilityScore)
			 VALUES (@id, @agentName, @timestamp, @taskDescription, @outcome, @lessonsLearned, @effectiveStrategies, @failurePatterns, @toolsUsed, @turnCount, @costUsd, @durationMs, @tags, @utilityScore)`,
		);

		this.getByAgentStmt = db.prepare(
			`SELECT * FROM episodes WHERE agentName = @agentName ORDER BY timestamp DESC LIMIT @limit`,
		);

		this.getByIdStmt = db.prepare(
			`SELECT * FROM episodes WHERE id = @id`,
		);

		this.countByAgentStmt = db.prepare(
			`SELECT COUNT(*) as c FROM episodes WHERE agentName = @agentName`,
		);

		this.pruneStmt = db.prepare(
			`DELETE FROM episodes WHERE id IN (SELECT id FROM episodes WHERE agentName = @agentName ORDER BY utilityScore ASC, timestamp ASC LIMIT @excess)`,
		);

		this.updateUtilityStmt = db.prepare(
			`UPDATE episodes SET utilityScore = @utilityScore, retrievalCount = retrievalCount + 1 WHERE id = @id`,
		);

		this.batchIncrementRetrievalStmt = db.prepare(
			`UPDATE episodes SET retrievalCount = retrievalCount + 1 WHERE id = @id`,
		);
	}

	/**
	 * Persist an episode to the database.
	 * Array fields are serialized as JSON strings.
	 */
	store(episode: Episode): void {
		this.insertStmt.run({
			id: episode.id,
			agentName: episode.agentName,
			timestamp: episode.timestamp,
			taskDescription: episode.taskDescription,
			outcome: episode.outcome,
			lessonsLearned: JSON.stringify(episode.lessonsLearned),
			effectiveStrategies: JSON.stringify(episode.effectiveStrategies),
			failurePatterns: JSON.stringify(episode.failurePatterns),
			toolsUsed: JSON.stringify(episode.toolsUsed),
			turnCount: episode.turnCount ?? null,
			costUsd: episode.costUsd ?? null,
			durationMs: episode.durationMs ?? null,
			tags: JSON.stringify(episode.tags),
			utilityScore: episode.utilityScore,
		});
	}

	/**
	 * Retrieve the most recent episodes for a given agent.
	 * Increments retrievalCount for each returned episode.
	 * @param agentName - agent to query
	 * @param limit - maximum number of episodes to return (default 20)
	 */
	getByAgent(agentName: string, limit = 20): Episode[] {
		const rows = this.getByAgentStmt.all({ agentName, limit }) as EpisodeRow[];
		const episodes = rows.map((row) => this.deserializeEpisode(row));

		// Increment retrieval count for all returned episodes
		for (const ep of episodes) {
			this.batchIncrementRetrievalStmt.run({ id: ep.id });
		}

		return episodes;
	}

	/**
	 * Retrieve a single episode by ID.
	 * Returns null if not found.
	 */
	getById(id: string): Episode | null {
		const row = this.getByIdStmt.get({ id }) as EpisodeRow | undefined;
		if (!row) return null;
		return this.deserializeEpisode(row);
	}

	/**
	 * Prune lowest-utility episodes when the agent exceeds maxEpisodes.
	 * Ties broken by timestamp ASC (oldest deleted first).
	 * @returns number of episodes deleted
	 */
	pruneExcess(agentName: string, maxEpisodes: number): number {
		const row = this.countByAgentStmt.get({ agentName }) as { c: number };
		const count = row.c;

		if (count <= maxEpisodes) {
			return 0;
		}

		const excess = count - maxEpisodes;
		const result = this.pruneStmt.run({ agentName, excess });
		return result.changes;
	}

	/**
	 * Update utility score and increment retrieval count for a specific episode.
	 */
	updateUtility(id: string, utilityScore: number): void {
		this.updateUtilityStmt.run({ id, utilityScore });
	}

	/**
	 * Deserialize a SQLite row back into a typed Episode.
	 */
	private deserializeEpisode(row: EpisodeRow): Episode {
		return {
			id: row.id,
			agentName: row.agentName,
			timestamp: row.timestamp,
			taskDescription: row.taskDescription,
			outcome: row.outcome as Episode["outcome"],
			lessonsLearned: JSON.parse(row.lessonsLearned) as string[],
			effectiveStrategies: JSON.parse(row.effectiveStrategies) as string[],
			failurePatterns: JSON.parse(row.failurePatterns) as string[],
			toolsUsed: JSON.parse(row.toolsUsed) as string[],
			turnCount: row.turnCount ?? undefined,
			costUsd: row.costUsd ?? undefined,
			durationMs: row.durationMs ?? undefined,
			tags: JSON.parse(row.tags) as string[],
			utilityScore: row.utilityScore,
			retrievalCount: row.retrievalCount,
		};
	}
}
