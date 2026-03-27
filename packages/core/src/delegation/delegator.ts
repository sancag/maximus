import type { AgentEngine } from "../runtime/engine.js";
import type { TaskStore } from "../tasks/store.js";
import type { BudgetTracker } from "../tasks/budget.js";
import type { AgentLock } from "./lock.js";
import type { EventBus } from "../events/bus.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { DelegationRequest } from "@maximus/shared";
import type { SessionResult } from "../runtime/types.js";
import { nanoid } from "nanoid";

export class HierarchyViolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HierarchyViolationError";
	}
}

export class CircuitBreakerError extends Error {
	constructor(
		public reason: "max_depth" | "max_concurrent",
		public value: number,
	) {
		super(`Circuit breaker: ${reason} (${value})`);
		this.name = "CircuitBreakerError";
	}
}

export class BudgetExceededError extends Error {
	constructor(
		public used: number,
		public ceiling: number,
	) {
		super(`Budget exceeded: ${used} >= ${ceiling}`);
		this.name = "BudgetExceededError";
	}
}

export class Delegator {
	constructor(
		private engine: Pick<AgentEngine, "runAgent">,
		private taskStore: TaskStore,
		private budgetTracker: BudgetTracker,
		private agentLock: AgentLock,
		private eventBus: EventBus,
		private registry: AgentRegistry,
	) {}

	async delegate(request: DelegationRequest): Promise<SessionResult> {
		// 1. Validate hierarchy
		if (!this.registry.canDelegateTo(request.fromAgent, request.toAgent)) {
			throw new HierarchyViolationError(
				`${request.fromAgent} cannot delegate to ${request.toAgent}`,
			);
		}

		// 2. Check circuit breakers
		const depth = this.taskStore.getChainDepth(request.traceId);
		const maxDepth = request.maxDepth ?? 5;
		if (depth >= maxDepth) {
			throw new CircuitBreakerError("max_depth", depth);
		}

		const concurrent = this.taskStore.getActiveConcurrentCount(
			request.traceId,
		);
		const maxConcurrent = request.maxConcurrent ?? 10;
		if (concurrent >= maxConcurrent) {
			throw new CircuitBreakerError("max_concurrent", concurrent);
		}

		// 3. Check token budget
		if (request.budgetCeiling !== undefined) {
			if (
				this.budgetTracker.isOverBudget(
					request.traceId,
					request.budgetCeiling,
				)
			) {
				throw new BudgetExceededError(
					this.budgetTracker.getChainUsage(request.traceId),
					request.budgetCeiling,
				);
			}
		}

		// 4. Create task
		const task = this.taskStore.create({
			parentTaskId: request.parentTaskId,
			agentName: request.toAgent,
			prompt: request.prompt,
			traceId: request.traceId,
		});

		this.eventBus.emit({
			id: nanoid(),
			timestamp: Date.now(),
			sessionId: "",
			agentName: request.toAgent,
			type: "task:created",
			payload: { taskId: task.id, parentTaskId: request.parentTaskId },
			traceId: request.traceId,
		});

		// 5. Transition to assigned, then in-progress
		this.taskStore.transition(task.id, "assigned");

		this.eventBus.emit({
			id: nanoid(),
			timestamp: Date.now(),
			sessionId: "",
			agentName: request.toAgent,
			type: "task:assigned",
			payload: { taskId: task.id },
			traceId: request.traceId,
		});

		// 6. Acquire lock and run
		await this.agentLock.acquire(request.toAgent);
		this.taskStore.transition(task.id, "in-progress");

		try {
			const result = await this.engine.runAgent({
				agentName: request.toAgent,
				prompt: request.prompt,
				traceId: request.traceId,
				parentTaskId: task.id,
			});

			// 7. Record token usage
			if (result.totalCostUsd !== undefined) {
				this.budgetTracker.record(
					request.traceId,
					result.totalCostUsd,
				);
			}

			// 8. Complete task
			this.taskStore.transition(task.id, "completed", {
				result: result.output,
				tokenUsage: result.totalCostUsd ?? 0,
			});

			this.eventBus.emit({
				id: nanoid(),
				timestamp: Date.now(),
				sessionId: result.sessionId,
				agentName: request.toAgent,
				type: "task:completed",
				payload: { taskId: task.id, output: result.output },
				traceId: request.traceId,
			});

			return result;
		} catch (error) {
			// 9. Fail task
			const errorMsg =
				error instanceof Error ? error.message : String(error);
			this.taskStore.transition(task.id, "failed", { error: errorMsg });

			this.eventBus.emit({
				id: nanoid(),
				timestamp: Date.now(),
				sessionId: "",
				agentName: request.toAgent,
				type: "task:failed",
				payload: { taskId: task.id, error: errorMsg },
				traceId: request.traceId,
			});

			throw error;
		} finally {
			this.agentLock.release(request.toAgent);
		}
	}
}
