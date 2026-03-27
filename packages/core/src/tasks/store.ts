import { nanoid } from "nanoid";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Task, TaskStatus, CreateTaskParams } from "@maximus/shared";
import { taskSchema } from "@maximus/shared";
import { validateTransition } from "./lifecycle.js";

export interface TaskStoreOptions {
	tasksPath?: string;
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

export class TaskStore {
	private tasks = new Map<string, Task>();
	private readonly tasksPath?: string;

	constructor(options: TaskStoreOptions = {}) {
		this.tasksPath = options.tasksPath;
		if (this.tasksPath) {
			this.load();
		}
	}

	private load(): void {
		if (!this.tasksPath || !existsSync(this.tasksPath)) return;
		try {
			const raw = readFileSync(this.tasksPath, "utf-8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return;
			for (const entry of parsed) {
				const task = taskSchema.parse(entry);
				this.tasks.set(task.id, task);
			}
		} catch {
			// Corrupt or missing file — start fresh
		}
	}

	private persist(): void {
		if (!this.tasksPath) return;
		atomicWriteJson(this.tasksPath, Array.from(this.tasks.values()));
	}

	create(params: CreateTaskParams): Task {
		const task: Task = {
			id: nanoid(),
			...params,
			status: "created",
			tokenUsage: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.tasks.set(task.id, task);
		this.persist();
		return task;
	}

	get(id: string): Task {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Task not found: ${id}`);
		return task;
	}

	transition(
		id: string,
		to: TaskStatus,
		update?: Partial<Task>,
	): Task {
		const task = this.get(id);
		if (!validateTransition(task.status, to)) {
			throw new Error(
				`Invalid transition: ${task.status} -> ${to}`,
			);
		}
		const updated: Task = {
			...task,
			...update,
			status: to,
			updatedAt: Date.now(),
		};
		if (to === "completed" || to === "failed") {
			updated.completedAt = Date.now();
		}
		this.tasks.set(id, updated);
		this.persist();
		return updated;
	}

	getByTraceId(traceId: string): Task[] {
		return Array.from(this.tasks.values()).filter(
			(t) => t.traceId === traceId,
		);
	}

	getChainDepth(traceId: string): number {
		const tasks = this.getByTraceId(traceId);
		let maxDepth = 0;
		for (const task of tasks) {
			let depth = 0;
			let current: Task | undefined = task;
			while (current?.parentTaskId) {
				depth++;
				current = this.tasks.get(current.parentTaskId);
			}
			maxDepth = Math.max(maxDepth, depth);
		}
		return maxDepth;
	}

	getActiveConcurrentCount(traceId: string): number {
		return this.getByTraceId(traceId).filter(
			(t) => t.status === "in-progress" || t.status === "assigned",
		).length;
	}

	getAll(): Task[] {
		return Array.from(this.tasks.values());
	}

	/**
	 * Block until a task reaches a terminal state (completed/failed) or timeout.
	 * Polls internally so the caller doesn't burn LLM turns.
	 */
	waitForCompletion(
		id: string,
		timeoutMs: number = 120_000,
		pollIntervalMs: number = 1_000,
	): Promise<Task> {
		const task = this.get(id);
		if (task.status === "completed" || task.status === "failed") {
			return Promise.resolve(task);
		}

		return new Promise((resolve) => {
			const deadline = Date.now() + timeoutMs;

			const poll = () => {
				const current = this.get(id);
				if (
					current.status === "completed" ||
					current.status === "failed" ||
					Date.now() >= deadline
				) {
					resolve(current);
					return;
				}
				setTimeout(poll, pollIntervalMs);
			};

			setTimeout(poll, pollIntervalMs);
		});
	}
}
