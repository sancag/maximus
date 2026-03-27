import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SQLITE_SCHEMA_DDL } from "./schema.js";

/**
 * Wrapper around better-sqlite3 for operational data storage.
 * Initializes with WAL mode and creates all required tables on open.
 */
export class SqliteClient {
	private constructor(private db: Database.Database) {}

	/**
	 * Open (or create) a SQLite database at the given path.
	 * Enables WAL mode and foreign keys, then runs schema DDL.
	 */
	static open(dbPath: string): SqliteClient {
		mkdirSync(dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		db.exec(SQLITE_SCHEMA_DDL);
		return new SqliteClient(db);
	}

	/**
	 * Access the underlying better-sqlite3 Database instance.
	 */
	get raw(): Database.Database {
		return this.db;
	}

	/**
	 * Close the database connection.
	 */
	close(): void {
		this.db.close();
	}
}
