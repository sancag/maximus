export class BudgetTracker {
	private usage = new Map<string, number>();

	record(traceId: string, tokens: number): void {
		const current = this.usage.get(traceId) ?? 0;
		this.usage.set(traceId, current + tokens);
	}

	getChainUsage(traceId: string): number {
		return this.usage.get(traceId) ?? 0;
	}

	isOverBudget(traceId: string, ceiling: number): boolean {
		return this.getChainUsage(traceId) >= ceiling;
	}
}
