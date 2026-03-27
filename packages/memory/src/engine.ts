import { join } from "node:path";
import { KuzuClient } from "./kuzu/client.js";
import { SqliteClient } from "./sqlite/client.js";

/**
 * MemoryEngine is the top-level facade for all memory operations.
 * It lazily initializes both the Kuzu graph database and SQLite operational database
 * under a configurable memory directory.
 */
export class MemoryEngine {
	private kuzuClient: KuzuClient | null = null;
	private sqliteClient: SqliteClient | null = null;

	constructor(private memoryDir: string) {}

	/**
	 * Get the Kuzu graph database client (lazy initialization).
	 */
	async getKuzu(): Promise<KuzuClient> {
		if (!this.kuzuClient) {
			this.kuzuClient = await KuzuClient.open(
				join(this.memoryDir, "knowledge.kuzu"),
			);
		}
		return this.kuzuClient;
	}

	/**
	 * Get the SQLite operational database client (lazy initialization).
	 */
	getSqlite(): SqliteClient {
		if (!this.sqliteClient) {
			this.sqliteClient = SqliteClient.open(
				join(this.memoryDir, "operational.db"),
			);
		}
		return this.sqliteClient;
	}

	/**
	 * Close all database connections and release resources.
	 */
	async close(): Promise<void> {
		if (this.sqliteClient) {
			this.sqliteClient.close();
			this.sqliteClient = null;
		}
		if (this.kuzuClient) {
			await this.kuzuClient.close();
			this.kuzuClient = null;
		}
	}
}
