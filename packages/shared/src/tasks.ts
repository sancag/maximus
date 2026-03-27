import { z } from "zod/v4";

export const taskStatusSchema = z.enum([
	"created",
	"assigned",
	"in-progress",
	"completed",
	"failed",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
	id: z.string(),
	parentTaskId: z.string().optional(),
	agentName: z.string(),
	status: taskStatusSchema,
	prompt: z.string(),
	result: z.string().optional(),
	error: z.string().optional(),
	traceId: z.string(),
	tokenUsage: z.number().default(0),
	createdAt: z.number(),
	updatedAt: z.number(),
	completedAt: z.number().optional(),
});
export type Task = z.infer<typeof taskSchema>;

export const createTaskParamsSchema = z.object({
	parentTaskId: z.string().optional(),
	agentName: z.string(),
	prompt: z.string(),
	traceId: z.string(),
});
export type CreateTaskParams = z.infer<typeof createTaskParamsSchema>;

export const delegationRequestSchema = z.object({
	fromAgent: z.string(),
	toAgent: z.string(),
	prompt: z.string(),
	traceId: z.string(),
	parentTaskId: z.string().optional(),
	maxDepth: z.number().optional().default(5),
	maxConcurrent: z.number().optional().default(10),
	budgetCeiling: z.number().optional(),
});
export type DelegationRequest = z.infer<typeof delegationRequestSchema>;
