import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "./bus.js";
import type { AgentEvent } from "@maximus/shared";

/**
 * Persists every event to a JSONL file grouped by traceId.
 * One file per trace: {tracesDir}/{traceId}.jsonl
 * Events without a traceId go to _untraced.jsonl.
 */
export class TraceLog {
	private unsubscribe: (() => void) | null = null;
	private ensuredDirs = new Set<string>();

	constructor(private tracesDir: string) {
		mkdirSync(tracesDir, { recursive: true });
		this.ensuredDirs.add(tracesDir);
	}

	attach(eventBus: EventBus): void {
		this.unsubscribe = eventBus.onAny((event: AgentEvent) => {
			this.write(event);
		});
	}

	detach(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
	}

	private write(event: AgentEvent): void {
		const fileName = event.traceId
			? `${event.traceId}.jsonl`
			: "_untraced.jsonl";
		const filePath = join(this.tracesDir, fileName);

		try {
			appendFileSync(filePath, JSON.stringify(event) + "\n");
		} catch {
			// Best-effort — don't crash the server if trace write fails
		}
	}
}
