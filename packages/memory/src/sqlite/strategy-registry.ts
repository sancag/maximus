import { nanoid } from "nanoid";
import type Database from "better-sqlite3";

export interface StrategyRecord {
	id: string;
	agentName: string;
	strategyText: string;
	usageCount: number;
	successCount: number;
	failureCount: number;
	successRate: number; // computed: successCount / (successCount + failureCount)
	lastUsedAt: number;
	firstSeenAt: number;
}

/**
 * Tracks strategy usage counts and success correlation per agent.
 * Uses an upsert pattern: first occurrence inserts, subsequent occurrences increment counters.
 */
export class StrategyRegistry {
	private upsertStmt: Database.Statement;
	private getByAgentStmt: Database.Statement;
	private getTopStmt: Database.Statement;

	constructor(private db: Database.Database) {
		this.upsertStmt = db.prepare(`
			INSERT INTO strategy_registry (id, agentName, strategyText, usageCount, successCount, failureCount, lastUsedAt, firstSeenAt)
			VALUES (?, ?, ?, 1, ?, ?, ?, ?)
			ON CONFLICT(agentName, strategyText) DO UPDATE SET
				usageCount = usageCount + 1,
				successCount = successCount + excluded.successCount,
				failureCount = failureCount + excluded.failureCount,
				lastUsedAt = excluded.lastUsedAt
		`);

		this.getByAgentStmt = db.prepare(`
			SELECT * FROM strategy_registry WHERE agentName = ? ORDER BY usageCount DESC
		`);

		this.getTopStmt = db.prepare(`
			SELECT * FROM strategy_registry WHERE agentName = ? ORDER BY usageCount DESC LIMIT ?
		`);
	}

	/**
	 * Record strategy usage from an episode. Call once per episode per strategy.
	 * @param agentName - the agent that used the strategy
	 * @param strategyText - the strategy string from effectiveStrategies
	 * @param outcome - the episode outcome (success/failure/partial)
	 */
	record(agentName: string, strategyText: string, outcome: "success" | "failure" | "partial"): void {
		const now = Date.now();
		const successInc = outcome === "success" ? 1 : 0;
		const failureInc = outcome === "failure" ? 1 : 0;
		this.upsertStmt.run(nanoid(), agentName, strategyText, successInc, failureInc, now, now);
	}

	/**
	 * Get all strategies for an agent, ordered by usage count descending.
	 */
	getByAgent(agentName: string): StrategyRecord[] {
		const rows = this.getByAgentStmt.all(agentName) as any[];
		return rows.map(this.toRecord);
	}

	/**
	 * Get top N strategies for an agent, ordered by usage count descending.
	 */
	getTopStrategies(agentName: string, limit: number = 5): StrategyRecord[] {
		const rows = this.getTopStmt.all(agentName, limit) as any[];
		return rows.map(this.toRecord);
	}

	private toRecord(row: any): StrategyRecord {
		const total = row.successCount + row.failureCount;
		return {
			id: row.id,
			agentName: row.agentName,
			strategyText: row.strategyText,
			usageCount: row.usageCount,
			successCount: row.successCount,
			failureCount: row.failureCount,
			successRate: total > 0 ? row.successCount / total : 0,
			lastUsedAt: row.lastUsedAt,
			firstSeenAt: row.firstSeenAt,
		};
	}
}
