import { z } from "zod/v4";

export const taskQuerySchema = z.object({
	traceId: z.string().optional(),
	agentName: z.string().optional(),
	status: z.string().optional(),
});
export type TaskQuery = z.infer<typeof taskQuerySchema>;

export const orgChartEntrySchema = z.object({
	name: z.string(),
	reportsTo: z.string().optional(),
	description: z.string(),
});

export const orgChartResponseSchema = z.object({
	agents: z.array(orgChartEntrySchema),
});
export type OrgChartResponse = z.infer<typeof orgChartResponseSchema>;
