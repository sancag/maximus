/**
 * AsyncChannel<T> - A simple async iterable channel for feeding values
 * to consumers. Push values in, read them out via async iteration.
 * Used to feed SDKUserMessages to query() as an AsyncIterable prompt.
 */
export class AsyncChannel<T> {
	private buffer: T[] = [];
	private waiter: { resolve: (result: IteratorResult<T>) => void } | null =
		null;
	private closed = false;

	push(value: T): void {
		if (this.closed) throw new Error("Channel is closed");
		if (this.waiter) {
			const w = this.waiter;
			this.waiter = null;
			w.resolve({ value, done: false });
		} else {
			this.buffer.push(value);
		}
	}

	close(): void {
		this.closed = true;
		if (this.waiter) {
			const w = this.waiter;
			this.waiter = null;
			w.resolve({ value: undefined as any, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: (): Promise<IteratorResult<T>> => {
				if (this.buffer.length > 0) {
					return Promise.resolve({
						value: this.buffer.shift()!,
						done: false,
					});
				}
				if (this.closed) {
					return Promise.resolve({
						value: undefined as any,
						done: true,
					});
				}
				return new Promise((resolve) => {
					this.waiter = { resolve };
				});
			},
		};
	}
}
