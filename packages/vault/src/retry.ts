export interface RetryPolicy {
	maxRetries: number;
	backoffMs?: number;
	backoffMultiplier?: number;
	maxBackoffMs?: number;
	shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_POLICY: Required<RetryPolicy> = {
	maxRetries: 3,
	backoffMs: 100,
	backoffMultiplier: 2,
	maxBackoffMs: 5000,
	shouldRetry: () => true,
};

export async function retryWithPolicy<T>(
	fn: () => Promise<T>,
	policy: RetryPolicy,
): Promise<T> {
	const config = { ...DEFAULT_POLICY, ...policy };
	let lastError: unknown;
	let delay = config.backoffMs;

	for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (attempt === config.maxRetries || !config.shouldRetry(error)) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, delay));
			delay = Math.min(delay * config.backoffMultiplier, config.maxBackoffMs);
		}
	}

	throw lastError; // Unreachable, but TypeScript needs it
}
