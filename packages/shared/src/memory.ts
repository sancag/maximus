import { z } from "zod/v4";

// --- Memory config for agent frontmatter ---

export const learningRateSchema = z.enum(["conservative", "moderate", "aggressive"]);
export type LearningRate = z.infer<typeof learningRateSchema>;

export const memoryConfigSchema = z.object({
	episodic: z.boolean().optional().default(true),
	maxEpisodes: z.number().int().min(1).max(500).optional().default(50),
	knowledgeScopes: z.array(z.string()).optional().default([]),
	briefingEnabled: z.boolean().optional().default(true),
	briefingTokenBudget: z.number().int().min(100).max(50000).optional().default(2000),
	learningRate: learningRateSchema.optional().default("moderate"),
});
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;

// --- Episode ---

export const episodeOutcomeSchema = z.enum(["success", "failure", "partial"]);
export type EpisodeOutcome = z.infer<typeof episodeOutcomeSchema>;

export const episodeSchema = z.object({
	id: z.string(),
	agentName: z.string(),
	timestamp: z.number(),
	taskDescription: z.string(),
	outcome: episodeOutcomeSchema,
	lessonsLearned: z.array(z.string()),
	effectiveStrategies: z.array(z.string()),
	failurePatterns: z.array(z.string()),
	toolsUsed: z.array(z.string()),
	turnCount: z.number().optional(),
	costUsd: z.number().optional(),
	durationMs: z.number().optional(),
	tags: z.array(z.string()),
	utilityScore: z.number().default(0),
	retrievalCount: z.number().default(0),
});
export type Episode = z.infer<typeof episodeSchema>;

// --- Knowledge graph ---

export const knowledgeEntitySchema = z.object({
	id: z.string(),
	name: z.string(),
	type: z.string(),
	attributes: z.record(z.string(), z.unknown()).optional(),
	createdBy: z.string(),
	firstSeen: z.number(),
	lastUpdated: z.number(),
});
export type KnowledgeEntity = z.infer<typeof knowledgeEntitySchema>;

export const knowledgeTripleSchema = z.object({
	sourceId: z.string(),
	targetId: z.string(),
	predicate: z.string(),
	scope: z.enum(["agent", "team", "global"]),
	validFrom: z.number(),
	validTo: z.number().optional(),
	confidence: z.number().min(0).max(1),
	evidence: z.string().optional(),
	createdBy: z.string(),
});
export type KnowledgeTriple = z.infer<typeof knowledgeTripleSchema>;

// --- Operational ---

export const agentMetricsSchema = z.object({
	id: z.string(),
	agentName: z.string(),
	timestamp: z.number(),
	successRate: z.number().optional(),
	avgTurns: z.number().optional(),
	avgCostUsd: z.number().optional(),
	avgDurationMs: z.number().optional(),
	totalSessions: z.number().default(0),
	windowStart: z.number().optional(),
	windowEnd: z.number().optional(),
});
export type AgentMetrics = z.infer<typeof agentMetricsSchema>;

export const briefingSchema = z.object({
	agentName: z.string(),
	content: z.string(),
	generatedAt: z.string(),
	episodeIds: z.array(z.string()),
	invalidated: z.boolean().default(false),
});
export type Briefing = z.infer<typeof briefingSchema>;

// --- Deep Sleep Config ---

export const deepSleepConfigSchema = z.object({
	staleTripleDays: z.number().int().min(1).default(30),
	lowUtilityMaxAge: z.number().int().min(1).default(14),
	lowUtilityMinScore: z.number().min(0).max(1).default(0.2),
	agentToTeamRetrievalCount: z.number().int().min(1).default(5),
	agentToTeamMinConfidence: z.number().min(0).max(1).default(0.7),
	agentToTeamMinAgents: z.number().int().min(2).default(2),
	teamToGlobalRetrievalCount: z.number().int().min(1).default(15),
	teamToGlobalMinConfidence: z.number().min(0).max(1).default(0.8),
	teamToGlobalMinTeams: z.number().int().min(2).default(2),
	maxTraceAgeDays: z.number().int().min(1).default(30),
	maxToolResultChars: z.number().int().min(100).default(2000),
});
export type DeepSleepConfig = z.infer<typeof deepSleepConfigSchema>;

export const pipelineResultSchema = z.object({
	tracesProcessed: z.number(),
	episodesCreated: z.number(),
	entitiesExtracted: z.number(),
	triplesExtracted: z.number(),
	triplesPromoted: z.number(),
	briefingsGenerated: z.number(),
	metricsComputed: z.number(),
	triplesPruned: z.number(),
	episodesPruned: z.number(),
	entitiesPruned: z.number(),
	tracesPruned: z.number(),
	stageErrors: z.array(z.object({ stage: z.string(), error: z.string() })),
});
export type PipelineResult = z.infer<typeof pipelineResultSchema>;
