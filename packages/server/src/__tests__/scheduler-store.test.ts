import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import {
	jobDefinitionSchema,
	jobRunSchema,
	jobStateSchema,
	MAX_RECENT_RUNS,
} from "../scheduler/types.js";
import { JobStore } from "../scheduler/store.js";

let dir: string;
let store: JobStore;

function validJobInput(overrides: Record<string, unknown> = {}) {
	return {
		id: "test-job",
		name: "Test Job",
		agent: "test-agent",
		prompt: "Do something",
		schedule: "*/5 * * * *",
		...overrides,
	};
}

function makeRun(jobId: string, index: number) {
	return {
		runId: `run-${index}`,
		jobId,
		startedAt: Date.now() + index,
		success: true,
	};
}

describe("jobDefinitionSchema", () => {
	it("accepts a valid job definition", () => {
		const result = jobDefinitionSchema.safeParse(validJobInput());
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.id).toBe("test-job");
			expect(result.data.enabled).toBe(true);
			expect(result.data.maxConcurrent).toBe(1);
		}
	});

	it("rejects job with missing required fields", () => {
		// agent and prompt are now optional (pipeline jobs don't need them)
		const noAgent = jobDefinitionSchema.safeParse({
			id: "test",
			name: "Test",
			prompt: "Do it",
			schedule: "* * * * *",
		});
		expect(noAgent.success).toBe(true);

		const noSchedule = jobDefinitionSchema.safeParse({
			id: "test",
			name: "Test",
			agent: "test-agent",
			prompt: "Do it",
		});
		expect(noSchedule.success).toBe(false);

		const noName = jobDefinitionSchema.safeParse({
			id: "test",
			schedule: "* * * * *",
		});
		expect(noName.success).toBe(false);
	});

	it("rejects job with invalid id format", () => {
		const uppercase = jobDefinitionSchema.safeParse(
			validJobInput({ id: "TestJob" }),
		);
		expect(uppercase.success).toBe(false);

		const spaces = jobDefinitionSchema.safeParse(
			validJobInput({ id: "test job" }),
		);
		expect(spaces.success).toBe(false);

		const startsWithNumber = jobDefinitionSchema.safeParse(
			validJobInput({ id: "1test" }),
		);
		expect(startsWithNumber.success).toBe(false);
	});
});

describe("JobStore", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "job-store-"));
		store = new JobStore({
			jobsPath: join(dir, "jobs.json"),
			statePath: join(dir, "job-state.json"),
		});
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("loadJobs returns empty array when file does not exist", () => {
		const jobs = store.loadJobs();
		expect(jobs).toEqual([]);
	});

	it("createJob writes job to file and loadJobs returns it", () => {
		const job = store.createJob(validJobInput());
		expect(job.id).toBe("test-job");
		expect(job.name).toBe("Test Job");

		const loaded = store.loadJobs();
		expect(loaded).toHaveLength(1);
		expect(loaded[0].id).toBe("test-job");
	});

	it("createJob rejects duplicate id", () => {
		store.createJob(validJobInput());
		expect(() => store.createJob(validJobInput())).toThrow(
			'Job with id "test-job" already exists',
		);
	});

	it("updateJob modifies existing job and persists change", () => {
		store.createJob(validJobInput());
		const updated = store.updateJob("test-job", { name: "Updated Name" });
		expect(updated.name).toBe("Updated Name");

		const loaded = store.loadJobs();
		expect(loaded[0].name).toBe("Updated Name");
	});

	it("updateJob throws if job not found", () => {
		expect(() => store.updateJob("nonexistent", { name: "X" })).toThrow(
			'Job with id "nonexistent" not found',
		);
	});

	it("deleteJob removes job from file", () => {
		store.createJob(validJobInput());
		store.createJob(validJobInput({ id: "other-job" }));
		expect(store.loadJobs()).toHaveLength(2);

		store.deleteJob("test-job");
		const remaining = store.loadJobs();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe("other-job");
	});

	it("deleteJob also cleans up state entry", () => {
		store.createJob(validJobInput());
		store.recordRun("test-job", makeRun("test-job", 1));
		expect(store.loadState()["test-job"]).toBeDefined();

		store.deleteJob("test-job");
		expect(store.loadState()["test-job"]).toBeUndefined();
	});

	it("recordRun persists run and trims to MAX_RECENT_RUNS", () => {
		const jobId = "trim-test";
		const totalRuns = MAX_RECENT_RUNS + 5; // 55 runs

		for (let i = 0; i < totalRuns; i++) {
			store.recordRun(jobId, makeRun(jobId, i));
		}

		const state = store.loadState();
		expect(state[jobId]).toBeDefined();
		expect(state[jobId].recentRuns).toHaveLength(MAX_RECENT_RUNS);
		expect(state[jobId].runCount).toBe(totalRuns);
		// Should keep the most recent runs (trimmed from front)
		expect(state[jobId].recentRuns[0].runId).toBe(`run-5`);
	});

	it("loadState returns empty object when file does not exist", () => {
		const state = store.loadState();
		expect(state).toEqual({});
	});

	it("atomic write produces valid JSON (re-instantiation test)", () => {
		store.createJob(validJobInput());
		store.createJob(validJobInput({ id: "second-job" }));

		// Re-instantiate store pointing to same files
		const store2 = new JobStore({
			jobsPath: join(dir, "jobs.json"),
			statePath: join(dir, "job-state.json"),
		});

		const jobs = store2.loadJobs();
		expect(jobs).toHaveLength(2);

		// Verify raw file is valid JSON
		const raw = readFileSync(join(dir, "jobs.json"), "utf-8");
		expect(() => JSON.parse(raw)).not.toThrow();
	});

	it("getJob returns job by id", () => {
		store.createJob(validJobInput());
		const job = store.getJob("test-job");
		expect(job).toBeDefined();
		expect(job!.id).toBe("test-job");
	});

	it("getJob returns undefined for missing id", () => {
		expect(store.getJob("nonexistent")).toBeUndefined();
	});
});
