import { z } from "zod/v4";

export const jobDefinitionSchema = z.object({
	id: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
	name: z.string().min(1).max(200),
	type: z.enum(["agent", "pipeline"]).default("agent"),
	agent: z.string().min(1).optional(),
	prompt: z.string().min(1).optional(),
	schedule: z.string().min(1),
	enabled: z.boolean().default(true),
	timezone: z.string().optional(),
	maxConcurrent: z.number().int().min(1).max(10).default(1),
});

export type JobDefinition = z.infer<typeof jobDefinitionSchema>;

export const jobRunSchema = z.object({
	runId: z.string(),
	jobId: z.string(),
	startedAt: z.number(),
	completedAt: z.number().optional(),
	success: z.boolean().optional(),
	output: z.string().optional(),
	error: z.string().optional(),
});

export type JobRun = z.infer<typeof jobRunSchema>;

export const jobStateSchema = z.object({
	lastRun: z.number().optional(),
	nextRun: z.number().optional(),
	runCount: z.number().default(0),
	lastStatus: z.enum(["success", "failed", "running"]).optional(),
	recentRuns: z.array(jobRunSchema).default([]),
});

export type JobState = z.infer<typeof jobStateSchema>;

export const MAX_RECENT_RUNS = 50;
