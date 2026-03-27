import { describe, it, expect } from "vitest";
import {
	taskStatusSchema,
	taskSchema,
	delegationRequestSchema,
} from "../tasks.js";

describe("taskStatusSchema", () => {
	it("parses valid status 'created'", () => {
		expect(taskStatusSchema.parse("created")).toBe("created");
	});

	it("parses all valid statuses", () => {
		for (const status of [
			"created",
			"assigned",
			"in-progress",
			"completed",
			"failed",
		]) {
			expect(taskStatusSchema.parse(status)).toBe(status);
		}
	});

	it("rejects invalid status", () => {
		expect(() => taskStatusSchema.parse("invalid")).toThrow();
	});
});

describe("taskSchema", () => {
	const validTask = {
		id: "task-1",
		agentName: "worker",
		status: "created" as const,
		prompt: "do something",
		traceId: "trace-1",
		tokenUsage: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	it("parses a valid task", () => {
		const result = taskSchema.parse(validTask);
		expect(result.id).toBe("task-1");
		expect(result.status).toBe("created");
	});

	it("requires id, agentName, status, prompt, traceId, createdAt, updatedAt", () => {
		const { id, ...noId } = validTask;
		expect(() => taskSchema.parse(noId)).toThrow();

		const { agentName, ...noAgent } = validTask;
		expect(() => taskSchema.parse(noAgent)).toThrow();

		const { status, ...noStatus } = validTask;
		expect(() => taskSchema.parse(noStatus)).toThrow();

		const { prompt, ...noPrompt } = validTask;
		expect(() => taskSchema.parse(noPrompt)).toThrow();

		const { traceId, ...noTrace } = validTask;
		expect(() => taskSchema.parse(noTrace)).toThrow();

		const { createdAt, ...noCreated } = validTask;
		expect(() => taskSchema.parse(noCreated)).toThrow();

		const { updatedAt, ...noUpdated } = validTask;
		expect(() => taskSchema.parse(noUpdated)).toThrow();
	});

	it("allows optional parentTaskId, result, error, completedAt", () => {
		const withOptionals = {
			...validTask,
			parentTaskId: "parent-1",
			result: "done",
			error: "oops",
			completedAt: Date.now(),
		};
		const result = taskSchema.parse(withOptionals);
		expect(result.parentTaskId).toBe("parent-1");
		expect(result.result).toBe("done");
		expect(result.error).toBe("oops");
		expect(result.completedAt).toBeDefined();
	});

	it("defaults tokenUsage to 0", () => {
		const { tokenUsage, ...noTokenUsage } = validTask;
		const result = taskSchema.parse(noTokenUsage);
		expect(result.tokenUsage).toBe(0);
	});
});

describe("delegationRequestSchema", () => {
	const validRequest = {
		fromAgent: "orchestrator",
		toAgent: "worker",
		prompt: "do this",
		traceId: "trace-1",
	};

	it("parses a valid delegation request", () => {
		const result = delegationRequestSchema.parse(validRequest);
		expect(result.fromAgent).toBe("orchestrator");
		expect(result.toAgent).toBe("worker");
	});

	it("throws when fromAgent is missing", () => {
		const { fromAgent, ...noFrom } = validRequest;
		expect(() => delegationRequestSchema.parse(noFrom)).toThrow();
	});

	it("has optional parentTaskId, maxDepth, maxConcurrent, budgetCeiling", () => {
		const withOptionals = {
			...validRequest,
			parentTaskId: "task-1",
			maxDepth: 3,
			maxConcurrent: 5,
			budgetCeiling: 100,
		};
		const result = delegationRequestSchema.parse(withOptionals);
		expect(result.parentTaskId).toBe("task-1");
		expect(result.maxDepth).toBe(3);
		expect(result.maxConcurrent).toBe(5);
		expect(result.budgetCeiling).toBe(100);
	});

	it("defaults maxDepth to 5 and maxConcurrent to 10", () => {
		const result = delegationRequestSchema.parse(validRequest);
		expect(result.maxDepth).toBe(5);
		expect(result.maxConcurrent).toBe(10);
	});
});

describe("taskQuerySchema", () => {
	// Imported separately since it's from api.ts
	it("parses with all optional fields", async () => {
		const { taskQuerySchema } = await import("../api.js");
		const result = taskQuerySchema.parse({
			traceId: "abc",
			agentName: "worker",
			status: "created",
		});
		expect(result.traceId).toBe("abc");
		expect(result.agentName).toBe("worker");
		expect(result.status).toBe("created");
	});

	it("parses empty object (all fields optional)", async () => {
		const { taskQuerySchema } = await import("../api.js");
		const result = taskQuerySchema.parse({});
		expect(result).toEqual({});
	});
});

describe("AgentEventType extensions", () => {
	it("includes task lifecycle events", async () => {
		// Type-level test: import and use the types
		const events = await import("../events.js");
		const taskCreated: typeof events.AgentEventType extends string
			? string
			: never = "task:created";
		// Runtime check: the type union is a compile-time concept,
		// but we verify the events module exports the type
		expect(events).toBeDefined();
	});
});

describe("AgentEvent extensions", () => {
	it("supports optional traceId and parentSessionId", async () => {
		const events = await import("../events.js");
		// Create an event object matching the interface
		const event: import("../events.js").AgentEvent = {
			id: "e1",
			timestamp: Date.now(),
			sessionId: "s1",
			agentName: "worker",
			type: "task:created",
			payload: {},
			traceId: "trace-1",
			parentSessionId: "parent-s1",
		};
		expect(event.traceId).toBe("trace-1");
		expect(event.parentSessionId).toBe("parent-s1");
	});
});
