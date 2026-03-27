import {
	existsSync,
	readFileSync,
	writeFileSync,
	renameSync,
	mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import pino from "pino";
import {
	jobDefinitionSchema,
	jobStateSchema,
	MAX_RECENT_RUNS,
	type JobDefinition,
	type JobRun,
	type JobState,
} from "./types.js";

const logger = pino({ name: "job-store" });

export interface JobStoreOptions {
	jobsPath: string;
	statePath: string;
}

function atomicWriteJson(filePath: string, data: unknown): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const tmp = filePath + ".tmp";
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
	renameSync(tmp, filePath);
}

export class JobStore {
	private readonly jobsPath: string;
	private readonly statePath: string;

	constructor(options: JobStoreOptions) {
		this.jobsPath = options.jobsPath;
		this.statePath = options.statePath;
	}

	loadJobs(): JobDefinition[] {
		if (!existsSync(this.jobsPath)) {
			return [];
		}
		try {
			const raw = readFileSync(this.jobsPath, "utf-8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				logger.warn("jobs file is not an array, returning empty");
				return [];
			}
			return parsed.map((entry: unknown) =>
				jobDefinitionSchema.parse(entry),
			);
		} catch (err) {
			logger.warn({ err }, "Failed to load jobs file, returning empty");
			return [];
		}
	}

	saveJobs(jobs: JobDefinition[]): void {
		atomicWriteJson(this.jobsPath, jobs);
	}

	loadState(): Record<string, JobState> {
		if (!existsSync(this.statePath)) {
			return {};
		}
		try {
			const raw = readFileSync(this.statePath, "utf-8");
			const parsed = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null) {
				logger.warn("state file is not an object, returning empty");
				return {};
			}
			const result: Record<string, JobState> = {};
			for (const [key, value] of Object.entries(parsed)) {
				result[key] = jobStateSchema.parse(value);
			}
			return result;
		} catch (err) {
			logger.warn({ err }, "Failed to load state file, returning empty");
			return {};
		}
	}

	saveState(state: Record<string, JobState>): void {
		atomicWriteJson(this.statePath, state);
	}

	recordRun(jobId: string, run: JobRun): void {
		const state = this.loadState();
		if (!state[jobId]) {
			state[jobId] = { runCount: 0, recentRuns: [] };
		}
		const jobState = state[jobId];
		jobState.recentRuns.push(run);
		if (jobState.recentRuns.length > MAX_RECENT_RUNS) {
			jobState.recentRuns = jobState.recentRuns.slice(
				-MAX_RECENT_RUNS,
			);
		}
		jobState.lastRun = run.startedAt;
		jobState.runCount += 1;
		jobState.lastStatus = run.success === true
			? "success"
			: run.success === false
				? "failed"
				: "running";
		this.saveState(state);
	}

	getJob(id: string): JobDefinition | undefined {
		const jobs = this.loadJobs();
		return jobs.find((j) => j.id === id);
	}

	createJob(input: unknown): JobDefinition {
		const job = jobDefinitionSchema.parse(input);
		const jobs = this.loadJobs();
		if (jobs.some((j) => j.id === job.id)) {
			throw new Error(`Job with id "${job.id}" already exists`);
		}
		jobs.push(job);
		this.saveJobs(jobs);
		return job;
	}

	updateJob(id: string, patch: Partial<JobDefinition>): JobDefinition {
		const jobs = this.loadJobs();
		const index = jobs.findIndex((j) => j.id === id);
		if (index === -1) {
			throw new Error(`Job with id "${id}" not found`);
		}
		const merged = { ...jobs[index], ...patch };
		const validated = jobDefinitionSchema.parse(merged);
		jobs[index] = validated;
		this.saveJobs(jobs);
		return validated;
	}

	deleteJob(id: string): void {
		const jobs = this.loadJobs();
		const filtered = jobs.filter((j) => j.id !== id);
		this.saveJobs(filtered);

		// Clean up state entry
		const state = this.loadState();
		if (state[id]) {
			delete state[id];
			this.saveState(state);
		}
	}
}
