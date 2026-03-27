export interface EngineConfig {
	agentsDir: string;
	skillsDir: string;
	vaultPath?: string;
	vaultKey?: string;
	defaultModel?: "sonnet" | "opus" | "haiku";
	defaultMaxTurns?: number;
	maxBudgetUsd?: number;
	memoryDir?: string;
	tasksPath?: string;
}

export interface SessionConfig {
	agentName: string;
	prompt: string;
	sessionId?: string; // For resuming sessions
	abortSignal?: AbortSignal;
	maxTurns?: number;
	maxDurationSeconds?: number;
	maxBudgetUsd?: number;
	// Trace context fields
	traceId?: string;
	parentTaskId?: string;
	parentSessionId?: string;
	maxToolResultChars?: number;
}

export interface SessionResult {
	sessionId: string;
	success: boolean;
	output?: string;
	numTurns?: number;
	totalCostUsd?: number;
	durationMs?: number;
	error?: string;
	// Trace context
	traceId?: string;
}

export interface PersistentSessionConfig {
	agentName: string;
	sessionId?: string;
	traceId?: string;
	maxTurns?: number;
}
