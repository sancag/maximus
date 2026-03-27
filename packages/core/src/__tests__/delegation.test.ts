import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentDefinition } from "@maximus/shared";
import type { DelegationRequest } from "@maximus/shared";
import { AgentRegistry } from "../agents/registry.js";
import { TaskStore } from "../tasks/store.js";
import { EventBus } from "../events/bus.js";
import { BudgetTracker } from "../tasks/budget.js";
import { AgentLock } from "../delegation/lock.js";
import {
	Delegator,
	HierarchyViolationError,
	CircuitBreakerError,
	BudgetExceededError,
} from "../delegation/delegator.js";
import { Messenger } from "../delegation/messenger.js";
import type { SessionResult } from "../runtime/types.js";

function makeAgent(
	overrides: Partial<AgentDefinition> & { name: string },
): AgentDefinition {
	return {
		description: `${overrides.name} agent`,
		model: "sonnet",
		maxTurns: 25,
		skills: [],
		prompt: "You are a test agent.",
		filePath: `/agents/${overrides.name}.md`,
		...overrides,
	};
}

function makeSuccessResult(overrides?: Partial<SessionResult>): SessionResult {
	return {
		sessionId: "sess-123",
		success: true,
		output: "done",
		numTurns: 1,
		totalCostUsd: 0.01,
		durationMs: 100,
		...overrides,
	};
}

// ─── BudgetTracker ───────────────────────────────────────────────────
describe("BudgetTracker", () => {
	let tracker: BudgetTracker;

	beforeEach(() => {
		tracker = new BudgetTracker();
	});

	it("records and retrieves usage for a trace", () => {
		tracker.record("trace1", 100);
		expect(tracker.getChainUsage("trace1")).toBe(100);
	});

	it("accumulates multiple records for same trace", () => {
		tracker.record("trace1", 50);
		tracker.record("trace1", 30);
		expect(tracker.getChainUsage("trace1")).toBe(80);
	});

	it("returns 0 for nonexistent trace", () => {
		expect(tracker.getChainUsage("nonexistent")).toBe(0);
	});

	it("isOverBudget returns false when under ceiling", () => {
		tracker.record("trace1", 100);
		expect(tracker.isOverBudget("trace1", 200)).toBe(false);
	});

	it("isOverBudget returns true when at or over ceiling", () => {
		tracker.record("trace1", 100);
		expect(tracker.isOverBudget("trace1", 50)).toBe(true);
	});
});

// ─── AgentLock ───────────────────────────────────────────────────────
describe("AgentLock", () => {
	let lock: AgentLock;

	beforeEach(() => {
		lock = new AgentLock();
	});

	it("acquire resolves immediately when no lock held", async () => {
		await lock.acquire("agent1");
		// If we got here, it resolved
		lock.release("agent1");
	});

	it("second acquire waits until release", async () => {
		await lock.acquire("agent1");

		let secondResolved = false;
		const secondPromise = lock.acquire("agent1").then(() => {
			secondResolved = true;
		});

		// Give microtasks a chance to run
		await new Promise((r) => setTimeout(r, 10));
		expect(secondResolved).toBe(false);

		lock.release("agent1");
		await secondPromise;
		expect(secondResolved).toBe(true);

		lock.release("agent1");
	});

	it("release when not locked is a no-op", () => {
		// Should not throw
		lock.release("agent1");
	});
});

// ─── Delegator ───────────────────────────────────────────────────────
describe("Delegator", () => {
	let registry: AgentRegistry;
	let taskStore: TaskStore;
	let budgetTracker: BudgetTracker;
	let agentLock: AgentLock;
	let eventBus: EventBus;
	let mockRunAgent: ReturnType<typeof vi.fn>;
	let delegator: Delegator;

	beforeEach(() => {
		registry = new AgentRegistry();
		registry.register(makeAgent({ name: "orchestrator" }));
		registry.register(
			makeAgent({ name: "manager", reportsTo: "orchestrator" }),
		);
		registry.register(
			makeAgent({ name: "worker1", reportsTo: "manager" }),
		);
		registry.register(
			makeAgent({ name: "worker2", reportsTo: "manager" }),
		);

		taskStore = new TaskStore();
		budgetTracker = new BudgetTracker();
		agentLock = new AgentLock();
		eventBus = new EventBus();

		mockRunAgent = vi.fn().mockResolvedValue(makeSuccessResult());

		const mockEngine = {
			runAgent: mockRunAgent,
		} as any;

		delegator = new Delegator(
			mockEngine,
			taskStore,
			budgetTracker,
			agentLock,
			eventBus,
			registry,
		);
	});

	function makeRequest(
		overrides?: Partial<DelegationRequest>,
	): DelegationRequest {
		return {
			fromAgent: "orchestrator",
			toAgent: "manager",
			prompt: "Do something",
			traceId: "trace-1",
			maxDepth: 5,
			maxConcurrent: 10,
			...overrides,
		};
	}

	it("delegate() with valid hierarchy creates task, runs agent, completes", async () => {
		const result = await delegator.delegate(makeRequest());

		expect(result.success).toBe(true);
		expect(mockRunAgent).toHaveBeenCalledOnce();

		// Verify task was created and completed
		const tasks = taskStore.getByTraceId("trace-1");
		expect(tasks).toHaveLength(1);
		expect(tasks[0].status).toBe("completed");
	});

	it("delegate() with invalid hierarchy throws HierarchyViolationError", async () => {
		await expect(
			delegator.delegate(
				makeRequest({ fromAgent: "worker1", toAgent: "orchestrator" }),
			),
		).rejects.toThrow(HierarchyViolationError);

		expect(mockRunAgent).not.toHaveBeenCalled();
	});

	it("delegate() when chain depth >= maxDepth throws CircuitBreakerError", async () => {
		// Pre-populate chain with depth >= 5
		// Create a deep chain: task0 -> task1 -> task2 -> task3 -> task4
		const t0 = taskStore.create({
			agentName: "a",
			prompt: "p",
			traceId: "trace-deep",
		});
		const t1 = taskStore.create({
			agentName: "b",
			prompt: "p",
			traceId: "trace-deep",
			parentTaskId: t0.id,
		});
		const t2 = taskStore.create({
			agentName: "c",
			prompt: "p",
			traceId: "trace-deep",
			parentTaskId: t1.id,
		});
		const t3 = taskStore.create({
			agentName: "d",
			prompt: "p",
			traceId: "trace-deep",
			parentTaskId: t2.id,
		});
		const t4 = taskStore.create({
			agentName: "e",
			prompt: "p",
			traceId: "trace-deep",
			parentTaskId: t3.id,
		});
		const t5 = taskStore.create({
			agentName: "f",
			prompt: "p",
			traceId: "trace-deep",
			parentTaskId: t4.id,
		});

		await expect(
			delegator.delegate(
				makeRequest({
					traceId: "trace-deep",
					maxDepth: 5,
				}),
			),
		).rejects.toThrow(CircuitBreakerError);
	});

	it("delegate() when concurrent count >= maxConcurrent throws CircuitBreakerError", async () => {
		// Create tasks in in-progress state to fill concurrent slots
		for (let i = 0; i < 3; i++) {
			const t = taskStore.create({
				agentName: `agent${i}`,
				prompt: "p",
				traceId: "trace-conc",
			});
			taskStore.transition(t.id, "assigned");
			taskStore.transition(t.id, "in-progress");
		}

		await expect(
			delegator.delegate(
				makeRequest({
					traceId: "trace-conc",
					maxConcurrent: 3,
				}),
			),
		).rejects.toThrow(CircuitBreakerError);
	});

	it("delegate() when budget exceeded throws BudgetExceededError", async () => {
		budgetTracker.record("trace-budget", 100);

		await expect(
			delegator.delegate(
				makeRequest({
					traceId: "trace-budget",
					budgetCeiling: 50,
				}),
			),
		).rejects.toThrow(BudgetExceededError);
	});

	it("delegate() acquires agent lock before running, releases after", async () => {
		const acquireSpy = vi.spyOn(agentLock, "acquire");
		const releaseSpy = vi.spyOn(agentLock, "release");

		await delegator.delegate(makeRequest());

		expect(acquireSpy).toHaveBeenCalledWith("manager");
		expect(releaseSpy).toHaveBeenCalledWith("manager");
	});

	it("delegate() emits task:created and task:completed events", async () => {
		const events: any[] = [];
		eventBus.onAny((e) => events.push(e));

		await delegator.delegate(makeRequest());

		const types = events.map((e) => e.type);
		expect(types).toContain("task:created");
		expect(types).toContain("task:completed");
	});

	it("delegate() when engine.runAgent throws transitions to failed and re-throws", async () => {
		mockRunAgent.mockRejectedValue(new Error("agent exploded"));

		const events: any[] = [];
		eventBus.onAny((e) => events.push(e));

		await expect(
			delegator.delegate(makeRequest({ traceId: "trace-fail" })),
		).rejects.toThrow("agent exploded");

		const tasks = taskStore.getByTraceId("trace-fail");
		expect(tasks).toHaveLength(1);
		expect(tasks[0].status).toBe("failed");

		const types = events.map((e) => e.type);
		expect(types).toContain("task:failed");
	});

	it("fan-out: concurrent delegation tracks both tasks as active", async () => {
		// Use deferred pattern to control when runAgent resolves
		let resolve1!: (v: SessionResult) => void;
		let resolve2!: (v: SessionResult) => void;

		mockRunAgent
			.mockImplementationOnce(
				() =>
					new Promise<SessionResult>((r) => {
						resolve1 = r;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<SessionResult>((r) => {
						resolve2 = r;
					}),
			);

		const traceId = "trace-fanout";

		const p1 = delegator.delegate(
			makeRequest({
				fromAgent: "manager",
				toAgent: "worker1",
				traceId,
			}),
		);
		const p2 = delegator.delegate(
			makeRequest({
				fromAgent: "manager",
				toAgent: "worker2",
				traceId,
			}),
		);

		// Let microtasks settle so both tasks enter in-progress
		await new Promise((r) => setTimeout(r, 10));

		// Both should be in-progress
		const activeTasks = taskStore
			.getByTraceId(traceId)
			.filter(
				(t) =>
					t.status === "in-progress" || t.status === "assigned",
			);
		expect(activeTasks.length).toBe(2);
		expect(taskStore.getActiveConcurrentCount(traceId)).toBe(2);

		// Resolve both
		resolve1(makeSuccessResult({ sessionId: "sess-w1" }));
		resolve2(makeSuccessResult({ sessionId: "sess-w2" }));

		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1.success).toBe(true);
		expect(r2.success).toBe(true);

		// Both tasks should be completed
		const allTasks = taskStore.getByTraceId(traceId);
		expect(allTasks.every((t) => t.status === "completed")).toBe(true);
	});
});

// ─── Messenger ───────────────────────────────────────────────────────
describe("Messenger", () => {
	let registry: AgentRegistry;
	let eventBus: EventBus;
	let messenger: Messenger;

	beforeEach(() => {
		registry = new AgentRegistry();
		registry.register(makeAgent({ name: "orchestrator" }));
		registry.register(
			makeAgent({ name: "worker1", reportsTo: "orchestrator" }),
		);
		registry.register(
			makeAgent({ name: "worker2", reportsTo: "orchestrator" }),
		);
		registry.register(
			makeAgent({ name: "manager", reportsTo: "orchestrator" }),
		);

		eventBus = new EventBus();
		messenger = new Messenger(registry, eventBus);
	});

	it("send() between same-level agents succeeds", () => {
		const msg = messenger.send(
			"worker1",
			"worker2",
			"hello",
			"trace-1",
		);
		expect(msg.fromAgent).toBe("worker1");
		expect(msg.toAgent).toBe("worker2");
		expect(msg.content).toBe("hello");
		expect(msg.traceId).toBe("trace-1");
		expect(msg.id).toBeDefined();
		expect(msg.timestamp).toBeGreaterThan(0);
	});

	it("send() between different-level agents throws HierarchyViolationError", () => {
		// orchestrator has no reportsTo, worker1 reports to orchestrator
		expect(() =>
			messenger.send("orchestrator", "worker1", "hello", "trace-1"),
		).toThrow(HierarchyViolationError);
	});
});
