import { z } from "zod/v4";

export const toolParameterSchema = z.object({
	type: z.enum(["string", "number", "boolean", "object", "array"]),
	description: z.string(),
	required: z.boolean().optional().default(true),
	items: z.any().optional(),
});

export const credentialInjectionSchema = z.object({
	ref: z.string().min(1),
	inject_as: z.string().min(1),
});

export const httpActionSchema = z.object({
	type: z.literal("http"),
	method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
	url: z.string().min(1),
	headers: z.record(z.string(), z.string()).optional(),
	body: z.union([z.record(z.string(), z.any()), z.string()]).optional(),
});

export const builtinActionSchema = z.object({
	type: z.literal("builtin"),
	handler: z.string().min(1),
});

export const toolActionSchema = z.discriminatedUnion("type", [
	httpActionSchema,
	builtinActionSchema,
]);

export const toolDefinitionSchema = z.object({
	name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
	description: z.string().min(1),
	parameters: z.record(z.string(), toolParameterSchema),
	credentials: z.array(credentialInjectionSchema).optional().default([]),
	action: toolActionSchema.optional(),
	output: z
		.object({
			include: z.array(z.string()).optional(),
		})
		.optional(),
});

export const skillSchema = z.object({
	name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
	description: z.string().min(1),
	version: z.string().optional().default("1.0"),
	credentials: z
		.array(
			z.object({
				name: z.string(),
				description: z.string(),
			}),
		)
		.optional()
		.default([]),
	tools: z.array(toolDefinitionSchema).min(1),
	instructions: z.string().optional(),
});

export type SkillDefinition = z.infer<typeof skillSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
