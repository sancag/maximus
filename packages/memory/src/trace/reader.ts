import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@maximus/shared";

/**
 * Reads JSONL trace files written by TraceLog.
 * Each line in the file is a JSON-serialized AgentEvent.
 */
export class TraceReader {
	constructor(private tracesDir: string) {}

	/**
	 * Read a trace file and return its events as a typed AgentEvent array.
	 * @param traceId - the trace ID (without .jsonl extension)
	 */
	readTrace(traceId: string): AgentEvent[] {
		const filePath = join(this.tracesDir, traceId + ".jsonl");
		const content = readFileSync(filePath, "utf-8");
		return content
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as AgentEvent);
	}

	/**
	 * List all trace IDs available in the traces directory.
	 * Excludes the _untraced.jsonl file used for events without a trace ID.
	 */
	listTraceIds(): string[] {
		if (!existsSync(this.tracesDir)) {
			return [];
		}
		return readdirSync(this.tracesDir)
			.filter((f) => f.endsWith(".jsonl") && f !== "_untraced.jsonl")
			.map((f) => f.slice(0, -".jsonl".length));
	}
}
