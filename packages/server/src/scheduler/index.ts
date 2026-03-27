import { Cron } from "croner";
import { nanoid } from "nanoid";
import pino from "pino";
import type { AgentEngine } from "@maximus/core";
import type { AgentEvent } from "@maximus/shared";
import { JobStore } from "./store.js";
import type { JobDefinition, JobRun, JobState } from "./types.js";

const logger = pino({ name: "job-scheduler" });

export class JobScheduler {
	private cronJobs = new Map<string, Cron>();
	private runningJobs = new Map<string, Set<string>>();
	private pipelineCallbacks = new Map<string, () => Promise<void>>();
	private pipelineDefs = new Map<string, JobDefinition>();

	constructor(
		private readonly engine: AgentEngine,
		private readonly store: JobStore,
	) {}

	registerPipeline(
		definition: {
			id: string;
			name: string;
			schedule: string;
			enabled?: boolean;
			timezone?: string;
			maxConcurrent?: number;
		},
		callback: () => Promise<void>,
	): void {
		this.pipelineCallbacks.set(definition.id, callback);
		this.pipelineDefs.set(definition.id, {
			id: definition.id,
			name: definition.name,
			type: "pipeline",
			schedule: definition.schedule,
			enabled: definition.enabled ?? true,
			timezone: definition.timezone,
			maxConcurrent: definition.maxConcurrent ?? 1,
		} as JobDefinition);
	}

	getStore(): JobStore {
		return this.store;
	}

	start(): void {
		const jobs = this.store.loadJobs();
		let scheduled = 0;

		for (const job of jobs) {
			if (!job.enabled) {
				continue;
			}

			const cron = new Cron(
				job.schedule,
				{ timezone: job.timezone, name: job.id },
				() => {
					void this.executeJob(job);
				},
			);
			this.cronJobs.set(job.id, cron);
			scheduled++;
		}

		// Schedule pipeline jobs
		for (const [id, def] of this.pipelineDefs) {
			if (!def.enabled) continue;
			const cron = new Cron(
				def.schedule,
				{ timezone: def.timezone, name: id },
				() => {
					void this.executeJob(def);
				},
			);
			this.cronJobs.set(id, cron);
			scheduled++;
		}

		logger.info({ scheduled, total: jobs.length }, "Scheduler started");
	}

	stop(): void {
		for (const cron of this.cronJobs.values()) {
			cron.stop();
		}
		this.cronJobs.clear();
		logger.info("Scheduler stopped");
	}

	async executeJob(job: JobDefinition): Promise<void> {
		const currentRunning = this.runningJobs.get(job.id);
		if (currentRunning && currentRunning.size >= job.maxConcurrent) {
			logger.warn(
				{ jobId: job.id, running: currentRunning.size, max: job.maxConcurrent },
				"Skipping job execution: max concurrent reached",
			);
			return;
		}

		const runId = nanoid();

		// Track running
		if (!this.runningJobs.has(job.id)) {
			this.runningJobs.set(job.id, new Set());
		}
		this.runningJobs.get(job.id)!.add(runId);

		const startedAt = Date.now();

		// Emit job:started
		this.emitEvent("job:started", job, runId);

		try {
			if (job.type === "pipeline") {
				// Pipeline execution path
				const callback = this.pipelineCallbacks.get(job.id);
				if (!callback) {
					throw new Error(`No pipeline callback registered for job: ${job.id}`);
				}
				await callback();

				const run: JobRun = {
					runId,
					jobId: job.id,
					startedAt,
					completedAt: Date.now(),
					success: true,
				};
				this.store.recordRun(job.id, run);
				this.emitEvent("job:completed", job, runId, {
					success: true,
					durationMs: Date.now() - startedAt,
				});
			} else {
				// Agent execution path
				if (!job.agent || !job.prompt) {
					throw new Error(`Agent job "${job.id}" requires agent and prompt fields`);
				}

				const result = await this.engine.runAgent({
					agentName: job.agent,
					prompt: job.prompt,
					traceId: `job-${job.id}-${runId}`,
				});

				const run: JobRun = {
					runId,
					jobId: job.id,
					startedAt,
					completedAt: Date.now(),
					success: result.success,
					output: result.output,
					error: result.error,
				};

				this.store.recordRun(job.id, run);

				// Emit job:completed
				this.emitEvent("job:completed", job, runId, {
					success: result.success,
					durationMs: run.completedAt! - run.startedAt,
				});
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);

			const run: JobRun = {
				runId,
				jobId: job.id,
				startedAt,
				completedAt: Date.now(),
				success: false,
				error: errorMessage,
			};

			this.store.recordRun(job.id, run);

			// Emit job:failed
			this.emitEvent("job:failed", job, runId, { error: errorMessage });

			logger.error({ jobId: job.id, runId, error: errorMessage }, "Job execution failed");
		} finally {
			this.runningJobs.get(job.id)?.delete(runId);
			if (this.runningJobs.get(job.id)?.size === 0) {
				this.runningJobs.delete(job.id);
			}
		}
	}

	async triggerJob(id: string): Promise<void> {
		const job = this.store.getJob(id) ?? this.pipelineDefs.get(id);
		if (!job) {
			throw new Error(`Job not found: ${id}`);
		}
		await this.executeJob(job);
	}

	listJobs(): Array<JobDefinition & { state: JobState }> {
		const fileJobs = this.store.loadJobs();
		const allJobs: JobDefinition[] = [...fileJobs, ...this.pipelineDefs.values()];
		const states = this.store.loadState();

		return allJobs.map((job) => {
			const state: JobState = states[job.id] ?? { runCount: 0, recentRuns: [] };

			// If there's an active cron for this job, get nextRun from it
			const cron = this.cronJobs.get(job.id);
			if (cron) {
				const nextRun = cron.nextRun();
				if (nextRun) {
					state.nextRun = nextRun.getTime();
				}
			}

			return { ...job, state };
		});
	}

	reload(): void {
		this.stop();
		this.start();
	}

	private emitEvent(
		type: "job:started" | "job:completed" | "job:failed",
		job: JobDefinition,
		runId: string,
		extra: Record<string, unknown> = {},
	): void {
		const event: AgentEvent = {
			id: nanoid(),
			timestamp: Date.now(),
			sessionId: `job-${job.id}-${runId}`,
			agentName: job.agent ?? "system",
			type,
			payload: {
				jobId: job.id,
				jobName: job.name,
				runId,
				...extra,
			},
		};

		this.engine.getEventBus().emit(event);
	}
}
