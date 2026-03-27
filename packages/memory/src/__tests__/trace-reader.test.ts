import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceReader } from "../trace/reader.js";
import type { AgentEvent } from "@maximus/shared";

function makeEvent(
	type: AgentEvent["type"],
	agentName = "test-agent",
	overrides: Partial<AgentEvent> = {},
): AgentEvent {
	return {
		id: `evt-${Math.random().toString(36).slice(2)}`,
		timestamp: Date.now(),
		sessionId: "sess-1",
		agentName,
		type,
		payload: {},
		...overrides,
	};
}

let tmpDir: string;

afterEach(() => {
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

describe("TraceReader", () => {
	it("readTrace parses JSONL into AgentEvent array", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "trace-test-"));
		const reader = new TraceReader(tmpDir);

		const events: AgentEvent[] = [
			makeEvent("session:start", "test-agent"),
			makeEvent("agent:message", "test-agent"),
			makeEvent("session:end", "test-agent"),
		];

		const jsonl = events.map((e) => JSON.stringify(e)).join("\n");
		writeFileSync(join(tmpDir, "test-trace.jsonl"), jsonl, "utf-8");

		const result = reader.readTrace("test-trace");

		expect(result).toHaveLength(3);
		expect(result[0].type).toBe("session:start");
		expect(result[0].agentName).toBe("test-agent");
	});

	it("readTrace handles empty lines in JSONL", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "trace-test-"));
		const reader = new TraceReader(tmpDir);

		const events: AgentEvent[] = [
			makeEvent("session:start"),
			makeEvent("agent:message"),
			makeEvent("session:end"),
		];

		// Insert blank lines between events
		const jsonl = events.map((e) => JSON.stringify(e)).join("\n\n");
		writeFileSync(join(tmpDir, "gappy-trace.jsonl"), jsonl, "utf-8");

		const result = reader.readTrace("gappy-trace");
		expect(result).toHaveLength(3);
	});

	it("listTraceIds returns trace IDs without .jsonl extension", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "trace-test-"));
		const reader = new TraceReader(tmpDir);

		writeFileSync(join(tmpDir, "trace-alpha.jsonl"), "", "utf-8");
		writeFileSync(join(tmpDir, "trace-beta.jsonl"), "", "utf-8");
		writeFileSync(join(tmpDir, "_untraced.jsonl"), "", "utf-8");

		const ids = reader.listTraceIds();
		expect(ids).toHaveLength(2);
		expect(ids).toContain("trace-alpha");
		expect(ids).toContain("trace-beta");
		expect(ids).not.toContain("_untraced");
	});

	it("listTraceIds returns empty array for nonexistent directory", () => {
		const reader = new TraceReader("/tmp/nonexistent-dir-abc123xyz");
		const ids = reader.listTraceIds();
		expect(ids).toEqual([]);
	});
});
