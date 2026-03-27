/**
 * Kuzu graph database schema DDL.
 * Creates the Entity node table and Related relationship table.
 */
export const KUZU_SCHEMA_DDL: string[] = [
	`CREATE NODE TABLE IF NOT EXISTS Entity(id STRING PRIMARY KEY, name STRING, type STRING, attributes STRING, createdBy STRING, firstSeen INT64, lastUpdated INT64)`,
	`CREATE REL TABLE IF NOT EXISTS Related(FROM Entity TO Entity, predicate STRING, scope STRING, validFrom INT64, validTo INT64, confidence DOUBLE, evidence STRING, createdBy STRING)`,
];
