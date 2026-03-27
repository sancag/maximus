import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { AgentEvent } from "@maximus/shared";

export interface TraceWriteOptions {
  traceId?: string;
  overwrite?: boolean;
}

export class TraceGenerator {
  constructor(private tracesDir: string) {}

  writeTrace(events: AgentEvent[], options: TraceWriteOptions = {}): string {
    const traceId = options.traceId ?? events[0]?.traceId ?? `trace-${Date.now()}`;
    const filePath = join(this.tracesDir, `${traceId}.jsonl`);

    // Ensure directory exists
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Check overwrite
    if (existsSync(filePath) && !options.overwrite) {
      throw new Error(`Trace file already exists: ${filePath}`);
    }

    // Write JSONL
    const content = events.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(filePath, content);

    return traceId;
  }

  writeTraces(traces: AgentEvent[][], options: TraceWriteOptions = {}): string[] {
    return traces.map((events) => this.writeTrace(events, options));
  }
}
