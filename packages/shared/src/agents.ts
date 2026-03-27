import { z } from "zod/v4";
import { memoryConfigSchema } from "./memory.js";

export const agentModelSchema = z.enum(["sonnet", "opus", "haiku"]);
export type AgentModel = z.infer<typeof agentModelSchema>;

export const agentFrontmatterSchema = z.object({
	name: z.string().min(1).max(100),
	description: z.string().min(1).max(500),
	model: agentModelSchema.optional().default("sonnet"),
	maxTurns: z.number().int().min(1).max(500).optional().default(25),
	maxDurationSeconds: z.number().int().min(10).max(3600).optional(),
	skills: z.array(z.string()).optional().default([]),
	reportsTo: z.string().optional(),
	memory: memoryConfigSchema.optional(),
});

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

export interface AgentDefinition extends AgentFrontmatter {
	/** The Markdown body, used as system prompt */
	prompt: string;
	/** Resolved file path */
	filePath: string;
}
