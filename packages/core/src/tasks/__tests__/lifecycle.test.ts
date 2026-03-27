import { describe, it, expect, beforeEach } from "vitest";
import { validateTransition } from "../lifecycle.js";
import { TaskStore } from "../store.js";

describe("validateTransition", () => {
	it("created -> assigned is valid", () => {
		expect(validateTransition("created", "assigned")).toBe(true);
	});

	it("assigned -> in-progress is valid", () => {
		expect(validateTransition("assigned", "in-progress")).toBe(true);
	});

	it("in-progress -> completed is valid", () => {
		expect(validateTransition("in-progress", "completed")).toBe(true);
	});

	it("in-progress -> failed is valid", () => {
		expect(validateTransition("in-progress", "failed")).toBe(true);
	});

	it("created -> completed is invalid", () => {
		expect(validateTransition("created", "completed")).toBe(false);
	});

	it("completed -> failed is invalid", () => {
		expect(validateTransition("completed", "failed")).toBe(false);
	});

	it("failed -> created is invalid", () => {
		expect(validateTransition("failed", "created")).toBe(false);
	});
});

describe("TaskStore", () => {
	let store: TaskStore;

	beforeEach(() => {
		store = new TaskStore();
	});

	it("create returns task with status 'created', non-empty id, createdAt set", () => {
		const task = store.create({
			agentName: "worker",
			prompt: "do X",
			traceId: "t1",
		});
		expect(task.status).toBe("created");
		expect(task.id).toBeTruthy();
		expect(task.createdAt).toBeGreaterThan(0);
	});

	it("get returns the same task", () => {
		const task = store.create({
			agentName: "worker",
			prompt: "do X",
			traceId: "t1",
		});
		expect(store.get(task.id)).toEqual(task);
	});

	it("get throws for nonexistent id", () => {
		expect(() => store.get("nonexistent")).toThrow();
	});

	it("transition to assigned returns task with updated status and updatedAt", async () => {
		const task = store.create({
			agentName: "worker",
			prompt: "do X",
			traceId: "t1",
		});
		// Small delay to ensure updatedAt differs
		await new Promise((r) => setTimeout(r, 5));
		const updated = store.transition(task.id, "assigned");
		expect(updated.status).toBe("assigned");
		expect(updated.updatedAt).toBeGreaterThanOrEqual(task.createdAt);
	});

	it("throws on invalid transition (assigned -> completed)", () => {
		const task = store.create({
			agentName: "worker",
			prompt: "do X",
			traceId: "t1",
		});
		store.transition(task.id, "assigned");
		expect(() => store.transition(task.id, "completed")).toThrow(
			"Invalid transition",
		);
	});

	it("transition to completed sets completedAt when in-progress", () => {
		const task = store.create({
			agentName: "worker",
			prompt: "do X",
			traceId: "t1",
		});
		store.transition(task.id, "assigned");
		store.transition(task.id, "in-progress");
		const completed = store.transition(task.id, "completed", {
			result: "done",
		});
		expect(completed.completedAt).toBeDefined();
		expect(completed.result).toBe("done");
	});

	it("getByTraceId returns matching tasks", () => {
		store.create({ agentName: "worker", prompt: "do X", traceId: "t1" });
		const results = store.getByTraceId("t1");
		expect(results).toHaveLength(1);
	});

	it("getByTraceId returns empty array for nonexistent trace", () => {
		expect(store.getByTraceId("nonexistent")).toEqual([]);
	});

	it("getChainDepth returns 0 for task with no parent", () => {
		store.create({ agentName: "worker", prompt: "do X", traceId: "t1" });
		expect(store.getChainDepth("t1")).toBe(0);
	});

	it("getChainDepth returns 1 for task with parentTaskId", () => {
		const parent = store.create({
			agentName: "manager",
			prompt: "manage",
			traceId: "t1",
		});
		store.create({
			agentName: "worker",
			prompt: "do X",
			traceId: "t1",
			parentTaskId: parent.id,
		});
		expect(store.getChainDepth("t1")).toBe(1);
	});

	it("getAll returns all tasks", () => {
		store.create({ agentName: "a", prompt: "1", traceId: "t1" });
		store.create({ agentName: "b", prompt: "2", traceId: "t2" });
		expect(store.getAll()).toHaveLength(2);
	});

	it("getActiveConcurrentCount counts in-progress and assigned tasks", () => {
		const t1 = store.create({
			agentName: "a",
			prompt: "1",
			traceId: "t1",
		});
		const t2 = store.create({
			agentName: "b",
			prompt: "2",
			traceId: "t1",
		});
		store.transition(t1.id, "assigned");
		store.transition(t2.id, "assigned");
		store.transition(t2.id, "in-progress");
		expect(store.getActiveConcurrentCount("t1")).toBe(2);
	});
});
