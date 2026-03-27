import { z } from "zod/v4";
import type { AgentRegistry } from "../agents/registry.js";
import type { AgentEngine } from "../runtime/engine.js";
import type { TaskStore } from "../tasks/store.js";
import { nanoid } from "nanoid";

/**
 * Creates an MCP server with `delegate` and `check_task` tools for agents
 * that have sub-agents. Delegation is non-blocking — the sub-agent runs
 * in the background and results are retrieved via check_task.
 */
export async function createDelegationMcpServer(
	parentAgentName: string,
	registry: AgentRegistry,
	engine: Pick<AgentEngine, "runAgent">,
	taskStore: TaskStore,
) {
	const { createSdkMcpServer, tool } = await import(
		"@anthropic-ai/claude-agent-sdk"
	);

	const reports = registry.getReports(parentAgentName);
	const agentNames = reports.map((a) => a.name);

	const agentDescriptions = reports
		.map((a) => `- **${a.name}**: ${a.description}`)
		.join("\n");

	return createSdkMcpServer({
		name: `${parentAgentName}-delegation`,
		version: "1.0.0",
		tools: [
			tool(
				"delegate",
				`Delegate a task to a sub-agent. Returns immediately with a task ID — the sub-agent runs in the background. Use check_task to retrieve results when ready.\n\nAvailable agents:\n${agentDescriptions}`,
				{
					agent: z
						.enum(agentNames as [string, ...string[]])
						.describe("Name of the agent to delegate to"),
					task: z
						.string()
						.describe(
							"Clear, specific description of what the agent should do. Describe the desired outcome, not how to achieve it — the agent has its own tools.",
						),
				},
				async (args: { agent: string; task: string }) => {
					const traceId = nanoid();
					const taskRecord = taskStore.create({
						agentName: args.agent,
						prompt: args.task,
						traceId,
					});
					taskStore.transition(taskRecord.id, "assigned");
					taskStore.transition(taskRecord.id, "in-progress");

					// Fire and forget — sub-agent runs in background
					engine
						.runAgent({
							agentName: args.agent,
							prompt: args.task,
							traceId,
							parentSessionId: parentAgentName,
						})
						.then((result) => {
							if (result.success) {
								taskStore.transition(taskRecord.id, "completed", {
									result: result.output,
									tokenUsage: result.totalCostUsd ?? 0,
								});
							} else {
								taskStore.transition(taskRecord.id, "failed", {
									error: result.error,
								});
							}
						})
						.catch((error) => {
							const msg =
								error instanceof Error
									? error.message
									: String(error);
							taskStore.transition(taskRecord.id, "failed", {
								error: msg,
							});
						});

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									status: "accepted",
									taskId: taskRecord.id,
									agent: args.agent,
									message: `Task delegated to ${args.agent}. Use check_task with taskId "${taskRecord.id}" to get results.`,
								}),
							},
						],
					};
				},
			),
			tool(
				"check_task",
				"Check the status and result of a delegated task. Blocks until the task completes or the timeout is reached. For waiting on multiple tasks at once, use wait_for_tasks instead.",
				{
					taskId: z
						.string()
						.describe("Task ID returned by delegate"),
					timeout_seconds: z
						.number()
						.int()
						.min(1)
						.max(300)
						.optional()
						.describe(
							"Max seconds to wait for completion (default: 120). The tool blocks until the task finishes or this timeout is reached.",
						),
				},
				async (args: {
					taskId: string;
					timeout_seconds?: number;
				}) => {
					try {
						const timeoutMs =
							(args.timeout_seconds ?? 120) * 1000;
						const task = await taskStore.waitForCompletion(
							args.taskId,
							timeoutMs,
						);

						if (task.status === "completed") {
							return {
								content: [
									{
										type: "text" as const,
										text: JSON.stringify({
											status: "completed",
											agent: task.agentName,
											result: task.result ?? "No output",
										}),
									},
								],
							};
						}

						if (task.status === "failed") {
							return {
								content: [
									{
										type: "text" as const,
										text: JSON.stringify({
											status: "failed",
											agent: task.agentName,
											error: task.error ?? "Unknown error",
										}),
									},
								],
								isError: true,
							};
						}

						// Timed out — still running
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										status: task.status,
										agent: task.agentName,
										message: `Still running after ${args.timeout_seconds ?? 120}s timeout. Call check_task again to keep waiting.`,
									}),
								},
							],
						};
					} catch {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										status: "not_found",
										error: `Task ${args.taskId} not found`,
									}),
								},
							],
							isError: true,
						};
					}
				},
			),
			tool(
				"wait_for_tasks",
				"Wait for multiple delegated tasks to complete. Blocks until ALL tasks reach a terminal state (completed/failed) or the timeout is reached. Use this after delegating multiple agents in parallel.",
				{
					task_ids: z
						.array(z.string())
						.min(1)
						.max(10)
						.describe("Array of task IDs returned by delegate"),
					timeout_seconds: z
						.number()
						.int()
						.min(1)
						.max(300)
						.optional()
						.describe(
							"Max seconds to wait for ALL tasks (default: 120)",
						),
				},
				async (args: {
					task_ids: string[];
					timeout_seconds?: number;
				}) => {
					const timeoutMs =
						(args.timeout_seconds ?? 120) * 1000;

					const results = await Promise.all(
						args.task_ids.map((id) =>
							taskStore
								.waitForCompletion(id, timeoutMs)
								.then((task) => {
									if (task.status === "completed") {
										return {
											taskId: id,
											status: "completed" as const,
											agent: task.agentName,
											result:
												task.result ?? "No output",
										};
									}
									if (task.status === "failed") {
										return {
											taskId: id,
											status: "failed" as const,
											agent: task.agentName,
											error:
												task.error ??
												"Unknown error",
										};
									}
									return {
										taskId: id,
										status: task.status,
										agent: task.agentName,
										message: "Still running after timeout",
									};
								})
								.catch(() => ({
									taskId: id,
									status: "not_found" as const,
									error: `Task ${id} not found`,
								})),
						),
					);

					const hasErrors = results.some(
						(r) =>
							r.status === "failed" ||
							r.status === "not_found",
					);

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									results,
									summary: {
										total: results.length,
										completed: results.filter(
											(r) =>
												r.status === "completed",
										).length,
										failed: results.filter(
											(r) => r.status === "failed",
										).length,
										still_running: results.filter(
											(r) =>
												r.status !== "completed" &&
												r.status !== "failed" &&
												r.status !== "not_found",
										).length,
									},
								}),
							},
						],
						...(hasErrors ? { isError: true } : {}),
					};
				},
			),
		],
	});
}
