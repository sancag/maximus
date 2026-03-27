import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobStore } from "../scheduler/store.js";
import { JobScheduler } from "../scheduler/index.js";
import type { JobDefinition } from "../scheduler/types.js";

// Mock AgentEngine
function createMockEngine(overrides: Record<string, unknown> = {}) {
	const emittedEvents: Array<Record<string, unknown>> = [];
	const eventBus = {
		emit: vi.fn((event: Record<string, unknown>) => {
			emittedEvents.push(event);
		}),
		on: vi.fn(() => () => {}),
		onAny: vi.fn(() => () => {}),
		removeAllListeners: vi.fn(),
	};
	return {
		engine: {
			runAgent: vi.fn().mockResolvedValue({
				sessionId: "sess-123",
				success: true,
				output: "Done",
			}),
			getEventBus: vi.fn(() => eventBus),
			getAgentRegistry: vi.fn(() => ({})),
			...overrides,
		} as any,
		eventBus,
		emittedEvents,
	};
}

function validJob(overrides: Partial<JobDefinition> = {}): Record<string, unknown> {
	return {
		id: "test-job",
		name: "Test Job",
		agent: "test-agent",
		prompt: "Do something",
		schedule: "0 * * * *",
		enabled: true,
		maxConcurrent: 1,
		...overrides,
	};
}

let dir: string;
let store: JobStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "scheduler-test-"));
	store = new JobStore({
		jobsPath: join(dir, "jobs.json"),
		statePath: join(dir, "job-state.json"),
	});
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("JobScheduler", () => {
	it("start/stop lifecycle: loads jobs and creates cron timers, stop clears them", () => {
		store.createJob(validJob());
		store.createJob(validJob({ id: "second-job", name: "Second" }));

		const { engine } = createMockEngine();
		const scheduler = new JobScheduler(engine, store);

		scheduler.start();
		// Two enabled jobs should produce two cron entries
		const jobs = scheduler.listJobs();
		expect(jobs).toHaveLength(2);

		scheduler.stop();
		// After stop, listJobs still works but nextRun should not come from active crons
		const jobsAfterStop = scheduler.listJobs();
		expect(jobsAfterStop).toHaveLength(2);
	});

	it("executeJob: engine.runAgent is called with correct config", async () => {
		store.createJob(validJob());

		const { engine } = createMockEngine();
		const scheduler = new JobScheduler(engine, store);
		scheduler.start();

		await scheduler.triggerJob("test-job");

		expect(engine.runAgent).toHaveBeenCalledTimes(1);
		const callArg = engine.runAgent.mock.calls[0][0];
		expect(callArg.agentName).toBe("test-agent");
		expect(callArg.prompt).toBe("Do something");
		expect(callArg.traceId).toMatch(/^job-test-job-/);

		scheduler.stop();
	});

	it("concurrent guard: skips execution when maxConcurrent reached", async () => {
		store.createJob(validJob({ maxConcurrent: 1 }));

		// Make runAgent hang until we resolve it
		let resolveRun!: (value: any) => void;
		const runPromise = new Promise((resolve) => {
			resolveRun = resolve;
		});
		const { engine } = createMockEngine({
			runAgent: vi.fn().mockReturnValue(runPromise),
		});

		const scheduler = new JobScheduler(engine, store);
		scheduler.start();

		// First trigger starts running (doesn't await)
		const firstRun = scheduler.triggerJob("test-job");
		// Second trigger should be skipped due to concurrency
		await scheduler.triggerJob("test-job");

		expect(engine.runAgent).toHaveBeenCalledTimes(1);

		// Resolve the first run
		resolveRun({ sessionId: "s1", success: true });
		await firstRun;

		scheduler.stop();
	});

	it("run recording: store.recordRun is called after job execution", async () => {
		store.createJob(validJob());

		const { engine } = createMockEngine();
		const scheduler = new JobScheduler(engine, store);
		scheduler.start();

		await scheduler.triggerJob("test-job");

		const state = store.loadState();
		expect(state["test-job"]).toBeDefined();
		expect(state["test-job"].runCount).toBe(1);
		expect(state["test-job"].lastStatus).toBe("success");
		expect(state["test-job"].recentRuns).toHaveLength(1);
		expect(state["test-job"].recentRuns[0].success).toBe(true);

		scheduler.stop();
	});

	it("disabled job: jobs with enabled=false do NOT get cron timers", () => {
		store.createJob(validJob({ enabled: false }));
		store.createJob(validJob({ id: "enabled-job", name: "Enabled", enabled: true }));

		const { engine } = createMockEngine();
		const scheduler = new JobScheduler(engine, store);
		scheduler.start();

		const jobs = scheduler.listJobs();
		// Both jobs listed but only enabled one should have a nextRun from cron
		const disabledJob = jobs.find((j) => j.id === "test-job");
		const enabledJob = jobs.find((j) => j.id === "enabled-job");

		// Disabled job should NOT have a nextRun from the cron
		// (no cron was created for it)
		expect(enabledJob!.state.nextRun).toBeDefined();
		// disabledJob has no cron so nextRun comes from stored state (undefined)
		expect(disabledJob!.state.nextRun).toBeUndefined();

		scheduler.stop();
	});

	it("event emission: job:started emitted before execution, job:completed after", async () => {
		store.createJob(validJob());

		const { engine, emittedEvents } = createMockEngine();
		const scheduler = new JobScheduler(engine, store);
		scheduler.start();

		await scheduler.triggerJob("test-job");

		const types = emittedEvents.map((e) => e.type);
		expect(types).toContain("job:started");
		expect(types).toContain("job:completed");

		const startedIdx = types.indexOf("job:started");
		const completedIdx = types.indexOf("job:completed");
		expect(startedIdx).toBeLessThan(completedIdx);

		const startedEvent = emittedEvents[startedIdx];
		expect((startedEvent.payload as any).jobId).toBe("test-job");

		scheduler.stop();
	});

	it("event emission: job:failed emitted on error", async () => {
		store.createJob(validJob());

		const { engine, emittedEvents } = createMockEngine({
			runAgent: vi.fn().mockRejectedValue(new Error("Agent crashed")),
		});
		const scheduler = new JobScheduler(engine, store);
		scheduler.start();

		await scheduler.triggerJob("test-job");

		const types = emittedEvents.map((e) => e.type);
		expect(types).toContain("job:started");
		expect(types).toContain("job:failed");

		// Run should be recorded as failed
		const state = store.loadState();
		expect(state["test-job"].lastStatus).toBe("failed");

		scheduler.stop();
	});

	it("shutdown stops crons: after stop(), triggerJob still works but no cron fires", () => {
		store.createJob(validJob());

		const { engine } = createMockEngine();
		const scheduler = new JobScheduler(engine, store);
		scheduler.start();
		scheduler.stop();

		// Cron jobs map should be empty after stop
		// listJobs still works (reads from store) but no active crons
		const jobs = scheduler.listJobs();
		expect(jobs).toHaveLength(1);
		// No nextRun since cron is stopped
		expect(jobs[0].state.nextRun).toBeUndefined();
	});

	it("listJobs: returns jobs merged with their state", async () => {
		store.createJob(validJob());

		const { engine } = createMockEngine();
		const scheduler = new JobScheduler(engine, store);
		scheduler.start();

		await scheduler.triggerJob("test-job");

		const jobs = scheduler.listJobs();
		expect(jobs).toHaveLength(1);
		expect(jobs[0].id).toBe("test-job");
		expect(jobs[0].state).toBeDefined();
		expect(jobs[0].state.lastRun).toBeDefined();
		expect(jobs[0].state.runCount).toBe(1);
		expect(jobs[0].state.nextRun).toBeDefined();

		scheduler.stop();
	});

	it("getStore: returns the JobStore instance for direct CRUD access", () => {
		const { engine } = createMockEngine();
		const scheduler = new JobScheduler(engine, store);

		expect(scheduler.getStore()).toBe(store);
	});

	describe("pipeline jobs", () => {
		it("registerPipeline + executeJob calls the callback and records a successful run", async () => {
			const { engine } = createMockEngine();
			const scheduler = new JobScheduler(engine, store);

			const callback = vi.fn().mockResolvedValue(undefined);
			scheduler.registerPipeline(
				{ id: "test-pipeline", name: "Test Pipeline", schedule: "0 4 * * *" },
				callback,
			);
			scheduler.start();

			await scheduler.triggerJob("test-pipeline");

			expect(callback).toHaveBeenCalledTimes(1);
			// engine.runAgent should NOT have been called (pipeline, not agent)
			expect(engine.runAgent).not.toHaveBeenCalled();

			// Run should be recorded
			const state = store.loadState();
			expect(state["test-pipeline"]).toBeDefined();
			expect(state["test-pipeline"].runCount).toBe(1);
			expect(state["test-pipeline"].lastStatus).toBe("success");

			scheduler.stop();
		});

		it("pipeline job failure records error run and emits job:failed", async () => {
			const { engine, emittedEvents } = createMockEngine();
			const scheduler = new JobScheduler(engine, store);

			const callback = vi.fn().mockRejectedValue(new Error("Pipeline blew up"));
			scheduler.registerPipeline(
				{ id: "fail-pipeline", name: "Fail Pipeline", schedule: "0 4 * * *" },
				callback,
			);
			scheduler.start();

			await scheduler.triggerJob("fail-pipeline");

			const state = store.loadState();
			expect(state["fail-pipeline"].lastStatus).toBe("failed");
			expect(state["fail-pipeline"].recentRuns[0].error).toBe("Pipeline blew up");

			const types = emittedEvents.map((e) => e.type);
			expect(types).toContain("job:failed");

			scheduler.stop();
		});

		it("pipeline job with no registered callback records error run", async () => {
			// Create a pipeline-type job in the store directly
			const { engine, emittedEvents } = createMockEngine();
			const scheduler = new JobScheduler(engine, store);
			scheduler.start();

			// Manually call executeJob with a pipeline definition (no callback registered)
			const pipelineJob = {
				id: "orphan-pipeline",
				name: "Orphan",
				type: "pipeline" as const,
				schedule: "0 * * * *",
				enabled: true,
				maxConcurrent: 1,
			};

			await scheduler.executeJob(pipelineJob);

			// Error should be recorded as a failed run
			const state = store.loadState();
			expect(state["orphan-pipeline"]).toBeDefined();
			expect(state["orphan-pipeline"].lastStatus).toBe("failed");
			expect(state["orphan-pipeline"].recentRuns[0].error).toBe(
				"No pipeline callback registered for job: orphan-pipeline",
			);

			const types = emittedEvents.map((e) => e.type);
			expect(types).toContain("job:failed");

			scheduler.stop();
		});

		it("pipeline job respects maxConcurrent check", async () => {
			const { engine } = createMockEngine();
			const scheduler = new JobScheduler(engine, store);

			let resolveCallback!: () => void;
			const hangingPromise = new Promise<void>((resolve) => {
				resolveCallback = resolve;
			});
			const callback = vi.fn().mockReturnValue(hangingPromise);

			scheduler.registerPipeline(
				{ id: "concurrent-pipeline", name: "Concurrent Pipeline", schedule: "0 4 * * *", maxConcurrent: 1 },
				callback,
			);
			scheduler.start();

			// First call starts running
			const firstRun = scheduler.triggerJob("concurrent-pipeline");
			// Second call should be skipped (max concurrent = 1)
			await scheduler.triggerJob("concurrent-pipeline");

			expect(callback).toHaveBeenCalledTimes(1);

			resolveCallback();
			await firstRun;

			scheduler.stop();
		});

		it("listJobs includes pipeline jobs", () => {
			const { engine } = createMockEngine();
			const scheduler = new JobScheduler(engine, store);

			// Add a file-based agent job
			store.createJob(validJob());

			// Register a pipeline job
			scheduler.registerPipeline(
				{ id: "list-pipeline", name: "List Pipeline", schedule: "0 4 * * *" },
				vi.fn().mockResolvedValue(undefined),
			);
			scheduler.start();

			const jobs = scheduler.listJobs();
			expect(jobs).toHaveLength(2);

			const pipelineJob = jobs.find((j) => j.id === "list-pipeline");
			expect(pipelineJob).toBeDefined();
			expect(pipelineJob!.name).toBe("List Pipeline");

			const agentJob = jobs.find((j) => j.id === "test-job");
			expect(agentJob).toBeDefined();

			scheduler.stop();
		});

		it("triggerJob works for pipeline jobs", async () => {
			const { engine } = createMockEngine();
			const scheduler = new JobScheduler(engine, store);

			const callback = vi.fn().mockResolvedValue(undefined);
			scheduler.registerPipeline(
				{ id: "trigger-pipeline", name: "Trigger Pipeline", schedule: "0 4 * * *" },
				callback,
			);
			scheduler.start();

			await scheduler.triggerJob("trigger-pipeline");
			expect(callback).toHaveBeenCalledTimes(1);

			scheduler.stop();
		});

		it("pipeline jobs emit job:started and job:completed events", async () => {
			const { engine, emittedEvents } = createMockEngine();
			const scheduler = new JobScheduler(engine, store);

			const callback = vi.fn().mockResolvedValue(undefined);
			scheduler.registerPipeline(
				{ id: "event-pipeline", name: "Event Pipeline", schedule: "0 4 * * *" },
				callback,
			);
			scheduler.start();

			await scheduler.triggerJob("event-pipeline");

			const types = emittedEvents.map((e) => e.type);
			expect(types).toContain("job:started");
			expect(types).toContain("job:completed");

			// agentName should be "system" for pipeline jobs
			const startedEvent = emittedEvents.find((e) => e.type === "job:started");
			expect(startedEvent!.agentName).toBe("system");

			scheduler.stop();
		});

		it("existing agent jobs still work with type field defaulting to agent", async () => {
			// Create a job without explicit type (backward compat)
			store.createJob(validJob());

			const { engine } = createMockEngine();
			const scheduler = new JobScheduler(engine, store);
			scheduler.start();

			await scheduler.triggerJob("test-job");

			expect(engine.runAgent).toHaveBeenCalledTimes(1);

			scheduler.stop();
		});
	});
});
