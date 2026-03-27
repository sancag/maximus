import type Database from "better-sqlite3";
import type { AgentMetrics } from "@maximus/shared";
import { nanoid } from "nanoid";

interface EpisodeRow {
	outcome: string;
	turnCount: number | null;
	costUsd: number | null;
	durationMs: number | null;
}

interface MetricsRow {
	id: string;
	agentName: string;
	timestamp: number;
	successRate: number | null;
	avgTurns: number | null;
	avgCostUsd: number | null;
	avgDurationMs: number | null;
	totalSessions: number;
	windowStart: number | null;
	windowEnd: number | null;
}

function rowToMetrics(row: MetricsRow): AgentMetrics {
	return {
		id: row.id,
		agentName: row.agentName,
		timestamp: row.timestamp,
		successRate: row.successRate ?? undefined,
		avgTurns: row.avgTurns ?? undefined,
		avgCostUsd: row.avgCostUsd ?? undefined,
		avgDurationMs: row.avgDurationMs ?? undefined,
		totalSessions: row.totalSessions,
		windowStart: row.windowStart ?? undefined,
		windowEnd: row.windowEnd ?? undefined,
	};
}

/**
 * Computes and persists per-agent performance metrics from episodes stored in SQLite.
 * Supports querying by agent name, time window, or latest snapshot.
 */
export class MetricsTracker {
	private insertStmt: Database.Statement;
	private getByAgentStmt: Database.Statement;
	private getByAgentWindowStmt: Database.Statement;
	private getLatestStmt: Database.Statement;
	private computeEpisodesStmt: Database.Statement;

	constructor(private db: Database.Database) {
		this.insertStmt = db.prepare(`
			INSERT INTO agent_metrics (id, agentName, timestamp, successRate, avgTurns, avgCostUsd, avgDurationMs, totalSessions, windowStart, windowEnd)
			VALUES (@id, @agentName, @timestamp, @successRate, @avgTurns, @avgCostUsd, @avgDurationMs, @totalSessions, @windowStart, @windowEnd)
		`);

		this.getByAgentStmt = db.prepare(`
			SELECT * FROM agent_metrics WHERE agentName = @agentName ORDER BY timestamp DESC LIMIT @limit
		`);

		this.getByAgentWindowStmt = db.prepare(`
			SELECT * FROM agent_metrics WHERE agentName = @agentName AND timestamp >= @windowStart AND timestamp <= @windowEnd ORDER BY timestamp DESC
		`);

		this.getLatestStmt = db.prepare(`
			SELECT * FROM agent_metrics WHERE agentName = @agentName ORDER BY timestamp DESC LIMIT 1
		`);

		this.computeEpisodesStmt = db.prepare(`
			SELECT outcome, turnCount, costUsd, durationMs FROM episodes WHERE agentName = ? AND timestamp >= ? AND timestamp <= ?
		`);
	}

	/**
	 * Query episodes for agentName within the time window, compute aggregate metrics,
	 * persist to agent_metrics, and return the computed AgentMetrics object.
	 */
	computeAndStore(agentName: string, windowStart?: number, windowEnd?: number): AgentMetrics {
		const end = windowEnd ?? Date.now();
		const start = windowStart ?? end - 30 * 24 * 60 * 60 * 1000;

		const rows = this.computeEpisodesStmt.all(agentName, start, end) as EpisodeRow[];

		const totalSessions = rows.length;
		let successRate: number | undefined;
		let avgTurns: number | undefined;
		let avgCostUsd: number | undefined;
		let avgDurationMs: number | undefined;

		if (totalSessions > 0) {
			const successCount = rows.filter((r) => r.outcome === "success").length;
			successRate = successCount / totalSessions;

			const turnValues = rows.map((r) => r.turnCount).filter((v): v is number => v !== null);
			if (turnValues.length > 0) {
				avgTurns = turnValues.reduce((a, b) => a + b, 0) / turnValues.length;
			}

			const costValues = rows.map((r) => r.costUsd).filter((v): v is number => v !== null);
			if (costValues.length > 0) {
				avgCostUsd = costValues.reduce((a, b) => a + b, 0) / costValues.length;
			}

			const durationValues = rows.map((r) => r.durationMs).filter((v): v is number => v !== null);
			if (durationValues.length > 0) {
				avgDurationMs = durationValues.reduce((a, b) => a + b, 0) / durationValues.length;
			}
		}

		const metrics: AgentMetrics = {
			id: nanoid(),
			agentName,
			timestamp: Date.now(),
			successRate,
			avgTurns,
			avgCostUsd,
			avgDurationMs,
			totalSessions,
			windowStart: start,
			windowEnd: end,
		};

		this.insertStmt.run({
			id: metrics.id,
			agentName: metrics.agentName,
			timestamp: metrics.timestamp,
			successRate: metrics.successRate ?? null,
			avgTurns: metrics.avgTurns ?? null,
			avgCostUsd: metrics.avgCostUsd ?? null,
			avgDurationMs: metrics.avgDurationMs ?? null,
			totalSessions: metrics.totalSessions,
			windowStart: metrics.windowStart ?? null,
			windowEnd: metrics.windowEnd ?? null,
		});

		return metrics;
	}

	/**
	 * Return the most recent N metrics snapshots for the given agent, ordered by timestamp DESC.
	 */
	getByAgent(agentName: string, limit = 10): AgentMetrics[] {
		const rows = this.getByAgentStmt.all({ agentName, limit }) as MetricsRow[];
		return rows.map(rowToMetrics);
	}

	/**
	 * Return all metrics snapshots for the given agent within the specified time window.
	 */
	getByWindow(agentName: string, windowStart: number, windowEnd: number): AgentMetrics[] {
		const rows = this.getByAgentWindowStmt.all({ agentName, windowStart, windowEnd }) as MetricsRow[];
		return rows.map(rowToMetrics);
	}

	/**
	 * Return the most recent metrics snapshot for the given agent, or null if none exists.
	 */
	getLatest(agentName: string): AgentMetrics | null {
		const row = this.getLatestStmt.get({ agentName }) as MetricsRow | undefined;
		return row ? rowToMetrics(row) : null;
	}
}
