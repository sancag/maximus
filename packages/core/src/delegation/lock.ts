export class AgentLock {
	private locks = new Map<
		string,
		{ release: () => void; promise: Promise<void> }
	>();
	private waitQueues = new Map<string, Array<() => void>>();

	async acquire(agentName: string): Promise<void> {
		if (!this.locks.has(agentName)) {
			// No lock held -- acquire immediately
			let releaseFn!: () => void;
			const promise = new Promise<void>((resolve) => {
				releaseFn = resolve;
			});
			this.locks.set(agentName, { release: releaseFn, promise });
			return;
		}
		// Lock is held -- wait in queue
		return new Promise<void>((resolve) => {
			const queue = this.waitQueues.get(agentName) ?? [];
			queue.push(resolve);
			this.waitQueues.set(agentName, queue);
		});
	}

	release(agentName: string): void {
		const lock = this.locks.get(agentName);
		if (!lock) return;

		const queue = this.waitQueues.get(agentName);
		if (queue && queue.length > 0) {
			// Hand lock to next waiter
			const next = queue.shift()!;
			let releaseFn!: () => void;
			const promise = new Promise<void>((resolve) => {
				releaseFn = resolve;
			});
			this.locks.set(agentName, { release: releaseFn, promise });
			next(); // resolve the waiter's promise
		} else {
			this.locks.delete(agentName);
		}
		lock.release();
	}
}
