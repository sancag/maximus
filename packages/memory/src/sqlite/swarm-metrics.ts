import type Database from "better-sqlite3";

export interface DelegationRecord {
	id: string;
	delegatorAgent: string;
	delegateeAgent: string;
	taskDescription?: string;
	outcome: "success" | "failure";
	timestamp: number;
	durationMs?: number;
}

export interface DelegationSuccessRate {
	total: number;
	successes: number;
	rate: number;
}

export interface DelegationSummaryRow extends DelegationSuccessRate {
	delegatorAgent: string;
	delegateeAgent: string;
}

export interface KnowledgeUtilizationResult {
	totalRetrievals: number;
	agentBreakdown: Array<{ agentName: string; retrievals: number }>;
}

interface RateRow {
	total: number;
	successes: number;
}

interface SummaryRow {
	delegatorAgent: string;
	delegateeAgent: string;
	total: number;
	successes: number;
}

/**
 * Tracks swarm-level metrics: delegation success rates across agent pairs
 * and knowledge utilization aggregation.
 *
 * Follows the same prepared-statement pattern as MetricsTracker and EpisodeStore.
 */
export class SwarmMetrics {
	private insertDelegationStmt: Database.Statement;
	private getSuccessRateStmt: Database.Statement;
	private getSummaryStmt: Database.Statement;

	constructor(private db: Database.Database) {
		this.insertDelegationStmt = db.prepare(`
			INSERT INTO delegation_metrics (id, delegatorAgent, delegateeAgent, taskDescription, outcome, timestamp, durationMs)
			VALUES (@id, @delegatorAgent, @delegateeAgent, @taskDescription, @outcome, @timestamp, @durationMs)
		`);

		this.getSuccessRateStmt = db.prepare(`
			SELECT
				COUNT(*) as total,
				SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes
			FROM delegation_metrics
			WHERE delegatorAgent = @delegatorAgent AND delegateeAgent = @delegateeAgent
		`);

		this.getSummaryStmt = db.prepare(`
			SELECT
				delegatorAgent,
				delegateeAgent,
				COUNT(*) as total,
				SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes
			FROM delegation_metrics
			GROUP BY delegatorAgent, delegateeAgent
		`);
	}

	/**
	 * Record a delegation event between two agents.
	 */
	recordDelegation(record: DelegationRecord): void {
		this.insertDelegationStmt.run({
			id: record.id,
			delegatorAgent: record.delegatorAgent,
			delegateeAgent: record.delegateeAgent,
			taskDescription: record.taskDescription ?? null,
			outcome: record.outcome,
			timestamp: record.timestamp,
			durationMs: record.durationMs ?? null,
		});
	}

	/**
	 * Get the delegation success rate for a specific delegator-delegatee pair.
	 * Returns { total, successes, rate } where rate is successes/total (0 if no delegations).
	 */
	getDelegationSuccessRate(delegatorAgent: string, delegateeAgent: string): DelegationSuccessRate {
		const row = this.getSuccessRateStmt.get({ delegatorAgent, delegateeAgent }) as RateRow;
		const total = row.total;
		const successes = row.successes ?? 0;
		const rate = total > 0 ? successes / total : 0;
		return { total, successes, rate };
	}

	/**
	 * Get delegation success rates aggregated across all delegator-delegatee pairs.
	 */
	getSwarmDelegationSummary(): DelegationSummaryRow[] {
		const rows = this.getSummaryStmt.all() as SummaryRow[];
		return rows.map((row) => ({
			delegatorAgent: row.delegatorAgent,
			delegateeAgent: row.delegateeAgent,
			total: row.total,
			successes: row.successes,
			rate: row.total > 0 ? row.successes / row.total : 0,
		}));
	}

	/**
	 * Aggregate knowledge utilization from pre-computed per-agent retrieval counts.
	 * This is a pure function -- it does not query the database.
	 * The caller (e.g., deep sleep consolidation) queries Kuzu for retrieval counts
	 * and passes them here for swarm-level aggregation.
	 */
	getKnowledgeUtilization(
		agentRetrievalCounts: Array<{ agentName: string; totalRetrievals: number }>,
	): KnowledgeUtilizationResult {
		const totalRetrievals = agentRetrievalCounts.reduce((sum, a) => sum + a.totalRetrievals, 0);
		const agentBreakdown = agentRetrievalCounts
			.map((a) => ({ agentName: a.agentName, retrievals: a.totalRetrievals }))
			.sort((a, b) => b.retrievals - a.retrievals);

		return { totalRetrievals, agentBreakdown };
	}
}
