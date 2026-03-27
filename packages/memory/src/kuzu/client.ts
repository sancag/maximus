import kuzu from "kuzu";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { KUZU_SCHEMA_DDL } from "./schema.js";

type KuzuDatabase = InstanceType<typeof kuzu.Database>;
type KuzuConnection = InstanceType<typeof kuzu.Connection>;

/**
 * Wrapper around Kuzu embedded graph database.
 * Initializes Entity and Related tables on first access.
 */
export class KuzuClient {
	private constructor(
		private db: KuzuDatabase,
		private conn: KuzuConnection,
	) {}

	/**
	 * Open (or create) a Kuzu database at the given path.
	 * Runs schema DDL to ensure tables exist.
	 */
	static async open(dbPath: string): Promise<KuzuClient> {
		mkdirSync(dirname(dbPath), { recursive: true });
		const db = new kuzu.Database(dbPath);
		const conn = new kuzu.Connection(db);

		for (const ddl of KUZU_SCHEMA_DDL) {
			try {
				await conn.query(ddl);
			} catch (_err) {
				// Table may already exist -- safe to ignore
			}
		}

		return new KuzuClient(db, conn);
	}

	/**
	 * Execute a Cypher query against the graph.
	 */
	async query(
		cypher: string,
		_params?: Record<string, unknown>,
	): Promise<unknown> {
		return this.conn.query(cypher);
	}

	/**
	 * Execute a parameterized Cypher query using prepared statements.
	 * Params keys should NOT include the $ prefix — just { id: "abc" } matches $id in the query.
	 * Falls back to numeric keys { "1": value } with $1 if named params don't work.
	 */
	async executePrepared(
		cypher: string,
		params: Record<string, unknown>,
	): Promise<unknown[]> {
		const stmt = await this.conn.prepare(cypher);
		const result = await this.conn.execute(stmt, params as Record<string, any>);
		const queryResult = Array.isArray(result) ? result[0] : result;
		return await queryResult.getAll();
	}

	/**
	 * Close the database connection.
	 */
	async close(): Promise<void> {
		try {
			await this.db.close();
		} catch {
			// Some versions may not support close -- null refs instead
		}
		(this as Record<string, unknown>).db = null;
		(this as Record<string, unknown>).conn = null;
	}
}
