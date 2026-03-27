/**
 * SQLite operational database schema DDL.
 * Creates episodes, agent_metrics, briefings, and _schema_version tables.
 */
export const SQLITE_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS episodes (
	id TEXT PRIMARY KEY,
	agentName TEXT NOT NULL,
	timestamp INTEGER NOT NULL,
	taskDescription TEXT NOT NULL,
	outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','partial')),
	lessonsLearned TEXT NOT NULL DEFAULT '[]',
	effectiveStrategies TEXT NOT NULL DEFAULT '[]',
	failurePatterns TEXT NOT NULL DEFAULT '[]',
	toolsUsed TEXT NOT NULL DEFAULT '[]',
	turnCount INTEGER,
	costUsd REAL,
	durationMs INTEGER,
	tags TEXT NOT NULL DEFAULT '[]',
	utilityScore REAL NOT NULL DEFAULT 0.0,
	retrievalCount INTEGER NOT NULL DEFAULT 0,
	createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_metrics (
	id TEXT PRIMARY KEY,
	agentName TEXT NOT NULL,
	timestamp INTEGER NOT NULL,
	successRate REAL,
	avgTurns REAL,
	avgCostUsd REAL,
	avgDurationMs REAL,
	totalSessions INTEGER NOT NULL DEFAULT 0,
	windowStart INTEGER,
	windowEnd INTEGER
);

CREATE TABLE IF NOT EXISTS briefings (
	agentName TEXT PRIMARY KEY,
	content TEXT NOT NULL,
	generatedAt TEXT NOT NULL,
	episodeIds TEXT NOT NULL DEFAULT '[]',
	invalidated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS _schema_version (
	version INTEGER PRIMARY KEY,
	appliedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_episodes_agent ON episodes(agentName, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_agent ON agent_metrics(agentName, timestamp DESC);

CREATE TABLE IF NOT EXISTS delegation_metrics (
	id TEXT PRIMARY KEY,
	delegatorAgent TEXT NOT NULL,
	delegateeAgent TEXT NOT NULL,
	taskDescription TEXT,
	outcome TEXT NOT NULL CHECK(outcome IN ('success','failure')),
	timestamp INTEGER NOT NULL,
	durationMs INTEGER
);

CREATE INDEX IF NOT EXISTS idx_delegation_delegator ON delegation_metrics(delegatorAgent, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_delegation_delegatee ON delegation_metrics(delegateeAgent, timestamp DESC);

CREATE TABLE IF NOT EXISTS processed_traces (
	traceId TEXT PRIMARY KEY,
	processedAt INTEGER NOT NULL,
	episodeId TEXT
);

CREATE TABLE IF NOT EXISTS prompt_versions (
	id TEXT PRIMARY KEY,
	promptHash TEXT NOT NULL UNIQUE,
	promptText TEXT NOT NULL,
	createdAt INTEGER NOT NULL,
	description TEXT
);

CREATE TABLE IF NOT EXISTS extraction_metrics (
	id TEXT PRIMARY KEY,
	promptVersionId TEXT NOT NULL,
	timestamp INTEGER NOT NULL,
	episodesProcessed INTEGER NOT NULL DEFAULT 0,
	entitiesExtracted INTEGER NOT NULL DEFAULT 0,
	triplesExtracted INTEGER NOT NULL DEFAULT 0,
	uniqueEntityRatio REAL,
	entitiesPerEpisode REAL,
	triplesPerEpisode REAL,
	FOREIGN KEY (promptVersionId) REFERENCES prompt_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_extraction_metrics_version
	ON extraction_metrics(promptVersionId, timestamp DESC);

CREATE TABLE IF NOT EXISTS strategy_registry (
	id TEXT PRIMARY KEY,
	agentName TEXT NOT NULL,
	strategyText TEXT NOT NULL,
	usageCount INTEGER NOT NULL DEFAULT 1,
	successCount INTEGER NOT NULL DEFAULT 0,
	failureCount INTEGER NOT NULL DEFAULT 0,
	lastUsedAt INTEGER NOT NULL,
	firstSeenAt INTEGER NOT NULL,
	UNIQUE(agentName, strategyText)
);

CREATE INDEX IF NOT EXISTS idx_strategy_registry_agent ON strategy_registry(agentName, usageCount DESC);
`;
