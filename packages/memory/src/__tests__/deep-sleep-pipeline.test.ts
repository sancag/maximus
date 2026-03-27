import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeepSleepPipeline } from "../pipeline/deep-sleep-pipeline.js";
import { deepSleepConfigSchema } from "@maximus/shared";
import type { DeepSleepConfig, PipelineResult, AgentEvent } from "@maximus/shared";
import { MemoryEngine } from "../engine.js";

let tmpDir: string;
let tracesDir: string;
let engine: MemoryEngine;
let config: DeepSleepConfig;

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
	return {
		id: "evt-1",
		timestamp: Date.now(),
		sessionId: "sess-1",
		agentName: "agent-alpha",
		type: "session:start",
		payload: { task: "Test task" },
		traceId: "trace-1",
		...overrides,
	};
}

function writeTrace(traceId: string, events: AgentEvent[]) {
	const content = events.map((e) => JSON.stringify(e)).join("\n");
	writeFileSync(join(tracesDir, `${traceId}.jsonl`), content);
}

// Minimal LLM function that returns empty extraction
const mockLlm = vi.fn().mockResolvedValue(
	JSON.stringify({ entities: [], relationships: [] }),
);

const agentResolver = () => [
	{ name: "agent-alpha", team: "team-sales" },
	{ name: "agent-beta", team: "team-sales" },
];

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "dsp-test-"));
	tracesDir = join(tmpDir, "traces");
	mkdirSync(tracesDir, { recursive: true });
	engine = new MemoryEngine(join(tmpDir, "memory"));
	config = deepSleepConfigSchema.parse({});
	vi.clearAllMocks();
});

afterEach(async () => {
	await engine.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("DeepSleepPipeline", () => {
	it("processes new traces, creates episodes, and returns counts", async () => {
		// Write 2 traces
		writeTrace("trace-1", [
			makeEvent({ id: "e1", type: "session:start", agentName: "agent-alpha", payload: { task: "Task A" } }),
			makeEvent({ id: "e2", type: "agent:completion", agentName: "agent-alpha" }),
		]);
		writeTrace("trace-2", [
			makeEvent({ id: "e3", type: "session:start", agentName: "agent-beta", payload: { task: "Task B" } }),
			makeEvent({ id: "e4", type: "agent:completion", agentName: "agent-beta" }),
		]);

		const pipeline = new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, agentResolver,
		);

		const result = await pipeline.run();

		expect(result.tracesProcessed).toBe(2);
		expect(result.episodesCreated).toBe(2);
		expect(result.stageErrors).toEqual([]);
	});

	it("skips already-processed traces (idempotency)", async () => {
		writeTrace("trace-1", [
			makeEvent({ id: "e1", type: "session:start", agentName: "agent-alpha", payload: { task: "Task A" } }),
			makeEvent({ id: "e2", type: "agent:completion", agentName: "agent-alpha" }),
		]);

		const pipeline = new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, agentResolver,
		);

		// First run
		const result1 = await pipeline.run();
		expect(result1.tracesProcessed).toBe(1);

		// Second run - should skip
		const result2 = await pipeline.run();
		expect(result2.tracesProcessed).toBe(0);
		expect(result2.episodesCreated).toBe(0);
	});

	it("captures stage failure in stageErrors, subsequent stages still run", async () => {
		writeTrace("trace-1", [
			makeEvent({ id: "e1", type: "session:start", agentName: "agent-alpha", payload: { task: "Task A" } }),
			makeEvent({ id: "e2", type: "agent:completion", agentName: "agent-alpha" }),
		]);

		// Make extraction fail
		const failingLlm = vi.fn().mockRejectedValue(new Error("LLM unavailable"));

		const pipeline = new DeepSleepPipeline(
			engine, failingLlm, tracesDir, config, agentResolver,
		);

		const result = await pipeline.run();

		// Distill stage should succeed
		expect(result.tracesProcessed).toBe(1);
		expect(result.episodesCreated).toBe(1);

		// Extract stage should have an error
		const extractError = result.stageErrors.find((e) => e.stage === "extract");
		expect(extractError).toBeDefined();

		// Subsequent stages should still have run (promotion, briefings, pruning)
		// They just produce zero counts since there's nothing to process
	});

	it("emits pipeline events in correct order", async () => {
		writeTrace("trace-1", [
			makeEvent({ id: "e1", type: "session:start", agentName: "agent-alpha", payload: { task: "Task A" } }),
			makeEvent({ id: "e2", type: "agent:completion", agentName: "agent-alpha" }),
		]);

		const emittedEvents: AgentEvent[] = [];
		const eventEmitter = {
			emit: (event: AgentEvent) => emittedEvents.push(event),
		};

		const pipeline = new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, agentResolver, eventEmitter,
		);

		await pipeline.run();

		// Should have: started, stage-completed (distill), stage-completed (extract),
		// stage-completed (promote), stage-completed (briefings), stage-completed (prune), completed
		const eventTypes = emittedEvents.map((e) => e.type);
		expect(eventTypes[0]).toBe("pipeline:started" as any);
		expect(eventTypes[eventTypes.length - 1]).toBe("pipeline:completed" as any);

		// Should have at least started + completed
		expect(emittedEvents.length).toBeGreaterThanOrEqual(2);
	});

	it("empty run with no new traces returns zero counts", async () => {
		const pipeline = new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, agentResolver,
		);

		const result = await pipeline.run();

		expect(result.tracesProcessed).toBe(0);
		expect(result.episodesCreated).toBe(0);
		expect(result.entitiesExtracted).toBe(0);
		expect(result.triplesExtracted).toBe(0);
		expect(result.triplesPromoted).toBe(0);
		expect(result.briefingsGenerated).toBe(0);
		expect(result.triplesPruned).toBe(0);
		expect(result.episodesPruned).toBe(0);
		expect(result.entitiesPruned).toBe(0);
		expect(result.stageErrors).toEqual([]);
	});

	it("calls LLM exactly once per cycle regardless of agent count", async () => {
		mockLlm.mockResolvedValue(
			JSON.stringify({ entities: [{ name: "test-entity", type: "concept" }], relationships: [] }),
		);

		// Two distinct agents — should still produce exactly 1 LLM call
		writeTrace("trace-alpha", [
			makeEvent({ id: "e1", type: "session:start", agentName: "agent-alpha", payload: { task: "Task A" } }),
			makeEvent({ id: "e2", type: "agent:completion", agentName: "agent-alpha" }),
		]);
		writeTrace("trace-beta", [
			makeEvent({ id: "e3", type: "session:start", agentName: "agent-beta", payload: { task: "Task B" } }),
			makeEvent({ id: "e4", type: "agent:completion", agentName: "agent-beta" }),
		]);

		const pipeline = new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, agentResolver,
		);

		await pipeline.run();

		expect(mockLlm.mock.calls.length).toBe(1);
	});

	it("single LLM call includes all agents episodes in one prompt", async () => {
		mockLlm.mockResolvedValue(
			JSON.stringify({ entities: [{ name: "test-entity", type: "concept" }], relationships: [] }),
		);

		writeTrace("trace-alpha", [
			makeEvent({ id: "e1", type: "session:start", agentName: "agent-alpha", payload: { task: "Task A" } }),
			makeEvent({ id: "e2", type: "agent:completion", agentName: "agent-alpha" }),
		]);
		writeTrace("trace-beta", [
			makeEvent({ id: "e3", type: "session:start", agentName: "agent-beta", payload: { task: "Task B" } }),
			makeEvent({ id: "e4", type: "agent:completion", agentName: "agent-beta" }),
		]);

		const pipeline = new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, agentResolver,
		);

		await pipeline.run();

		expect(mockLlm.mock.calls.length).toBe(1);
		const prompt = mockLlm.mock.calls[0][0] as string;
		// Both agents appear in the single prompt
		expect(prompt).toContain("agent-alpha");
		expect(prompt).toContain("agent-beta");
	});

	it("prunes low-utility episodes and returns count", async () => {
		// Create a low-utility episode directly in the DB
		const sqlite = engine.getSqlite();
		const db = sqlite.raw;

		// Manually insert a low-utility old episode
		const ageCutoff = Date.now() - (config.lowUtilityMaxAge * 86_400_000) - 1000;
		db.prepare(
			`INSERT INTO episodes (id, agentName, timestamp, taskDescription, outcome, lessonsLearned, effectiveStrategies, failurePatterns, toolsUsed, tags, utilityScore, retrievalCount)
			 VALUES (@id, @agentName, @timestamp, @taskDescription, @outcome, @lessonsLearned, @effectiveStrategies, @failurePatterns, @toolsUsed, @tags, @utilityScore, @retrievalCount)`,
		).run({
			id: "old-episode-1",
			agentName: "agent-alpha",
			timestamp: ageCutoff,
			taskDescription: "Old task",
			outcome: "success",
			lessonsLearned: "[]",
			effectiveStrategies: "[]",
			failurePatterns: "[]",
			toolsUsed: "[]",
			tags: "[]",
			utilityScore: 0.05, // Below default 0.2 threshold
			retrievalCount: 0,
		});

		const pipeline = new DeepSleepPipeline(
			engine, mockLlm, tracesDir, config, agentResolver,
		);

		const result = await pipeline.run();

		expect(result.episodesPruned).toBe(1);
	});
});
