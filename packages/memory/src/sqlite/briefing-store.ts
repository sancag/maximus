import type Database from "better-sqlite3";
import type { Briefing } from "@maximus/shared";

/**
 * Row type as returned from SQLite (episodeIds stored as JSON string, invalidated as 0/1).
 */
interface BriefingRow {
	agentName: string;
	content: string;
	generatedAt: string;
	episodeIds: string;
	invalidated: number;
}

/**
 * Persists, retrieves, and invalidates briefings in SQLite.
 * Uses prepared statements (same pattern as EpisodeStore).
 */
export class BriefingStore {
	private saveStmt: Database.Statement;
	private getStmt: Database.Statement;
	private invalidateStmt: Database.Statement;
	private isValidStmt: Database.Statement;

	constructor(private db: Database.Database) {
		this.saveStmt = db.prepare(
			`INSERT OR REPLACE INTO briefings (agentName, content, generatedAt, episodeIds, invalidated)
			 VALUES (@agentName, @content, @generatedAt, @episodeIds, 0)`,
		);

		this.getStmt = db.prepare(
			`SELECT * FROM briefings WHERE agentName = @agentName`,
		);

		this.invalidateStmt = db.prepare(
			`UPDATE briefings SET invalidated = 1 WHERE agentName = @agentName`,
		);

		this.isValidStmt = db.prepare(
			`SELECT invalidated FROM briefings WHERE agentName = @agentName`,
		);
	}

	/**
	 * Save (insert or replace) a briefing. New briefings are always valid (invalidated=0).
	 */
	save(briefing: Briefing): void {
		this.saveStmt.run({
			agentName: briefing.agentName,
			content: briefing.content,
			generatedAt: briefing.generatedAt,
			episodeIds: JSON.stringify(briefing.episodeIds),
		});
	}

	/**
	 * Retrieve a briefing by agent name, or null if not found.
	 */
	get(agentName: string): Briefing | null {
		const row = this.getStmt.get({ agentName }) as BriefingRow | undefined;
		if (!row) return null;
		return {
			agentName: row.agentName,
			content: row.content,
			generatedAt: row.generatedAt,
			episodeIds: JSON.parse(row.episodeIds) as string[],
			invalidated: row.invalidated === 1,
		};
	}

	/**
	 * Mark a briefing as invalidated. Next generate() call will rebuild.
	 */
	invalidate(agentName: string): void {
		this.invalidateStmt.run({ agentName });
	}

	/**
	 * Returns true only if a briefing exists and is not invalidated.
	 */
	isValid(agentName: string): boolean {
		const row = this.isValidStmt.get({ agentName }) as
			| { invalidated: number }
			| undefined;
		if (!row) return false;
		return row.invalidated === 0;
	}
}
