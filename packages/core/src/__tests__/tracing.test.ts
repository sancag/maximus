import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "@maximus/shared";
import type { AgentDefinition } from "@maximus/shared";
import { EventBus } from "../events/bus.js";
import type { SessionConfig, SessionResult } from "../runtime/types.js";

// Mock the Claude Agent SDK before importing AgentSession
// Include tool + createSdkMcpServer to avoid polluting other tests (e.g. composer.test.ts)
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
	createSdkMcpServer: vi.fn((config: any) => config),
	tool: vi.fn(
		(name: string, desc: string, schema: any, handler: any) => ({
			name,
			description: desc,
			schema,
			handler,
		}),
	),
}));

// Mock hooks to avoid side effects
vi.mock("../runtime/hooks.js", () => ({
	createHooks: vi.fn(() => ({})),
	filterEnvForSdk: vi.fn(() => ({})),
}));

import { AgentSession } from "../runtime/session.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

const mockedQuery = vi.mocked(query);

function makeAgent(name = "test-agent"): AgentDefinition {
	return {
		name,
		description: "test",
		model: "sonnet",
		maxTurns: 25,
		skills: [],
		prompt: "You are a test agent.",
		filePath: `/agents/${name}.md`,
	};
}

// Helper to create an async iterable from an array of messages
function mockQueryStream(messages: Record<string, any>[]): AsyncIterable<any> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const msg of messages) {
				yield msg;
			}
		},
	};
}

describe("SessionConfig trace fields", () => {
	it("SessionConfig accepts traceId, parentTaskId, parentSessionId", () => {
		const config: SessionConfig = {
			agentName: "test",
			prompt: "hello",
			traceId: "trace-abc",
			parentTaskId: "task-123",
			parentSessionId: "sess-parent",
		};
		expect(config.traceId).toBe("trace-abc");
		expect(config.parentTaskId).toBe("task-123");
		expect(config.parentSessionId).toBe("sess-parent");
	});
});

describe("AgentSession trace propagation", () => {
	let eventBus: EventBus;
	let events: AgentEvent[];

	beforeEach(() => {
		eventBus = new EventBus();
		events = [];
		eventBus.onAny((e) => events.push(e));
		vi.clearAllMocks();
	});

	it("emits events with traceId and parentSessionId", async () => {
		mockedQuery.mockReturnValue(
			mockQueryStream([
				{
					type: "result",
					subtype: "success",
					result: "output",
					num_turns: 1,
					total_cost_usd: 0.01,
				},
			]) as any,
		);

		const session = new AgentSession(makeAgent(), {}, eventBus, {
			agentName: "test-agent",
			prompt: "hello",
			traceId: "trace-xyz",
			parentSessionId: "parent-sess-1",
		});

		const result = await session.run();

		// All emitted events should have traceId
		for (const event of events) {
			expect(event.traceId).toBe("trace-xyz");
			expect(event.parentSessionId).toBe("parent-sess-1");
		}

		// session:start and session:end should be present
		const types = events.map((e) => e.type);
		expect(types).toContain("session:start");
		expect(types).toContain("session:end");
	});

	it("SessionResult includes traceId", async () => {
		mockedQuery.mockReturnValue(
			mockQueryStream([
				{
					type: "result",
					subtype: "success",
					result: "done",
					num_turns: 1,
					total_cost_usd: 0.005,
				},
			]) as any,
		);

		const session = new AgentSession(makeAgent(), {}, eventBus, {
			agentName: "test-agent",
			prompt: "hello",
			traceId: "trace-result",
		});

		const result = await session.run();
		expect(result.traceId).toBe("trace-result");
	});

	it("generates traceId when not provided", async () => {
		mockedQuery.mockReturnValue(
			mockQueryStream([
				{
					type: "result",
					subtype: "success",
					result: "done",
					num_turns: 1,
					total_cost_usd: 0,
				},
			]) as any,
		);

		const session = new AgentSession(makeAgent(), {}, eventBus, {
			agentName: "test-agent",
			prompt: "hello",
		});

		const result = await session.run();
		expect(result.traceId).toBeDefined();
		expect(result.traceId!.length).toBeGreaterThan(0);
	});
});

describe("Block chunking", () => {
	let eventBus: EventBus;
	let events: AgentEvent[];

	beforeEach(() => {
		eventBus = new EventBus();
		events = [];
		eventBus.onAny((e) => events.push(e));
		vi.clearAllMocks();
	});

	it("batches multiple small text fragments into a single chunked message", async () => {
		// Emit multiple assistant messages with small text content
		// They should be batched since they are under BLOCK_MIN_CHARS individually
		const longText = "A".repeat(100); // Over BLOCK_MIN_CHARS
		mockedQuery.mockReturnValue(
			mockQueryStream([
				{
					type: "assistant",
					message: {
						content: [
							{ type: "text", text: longText.slice(0, 40) },
						],
					},
				},
				{
					type: "assistant",
					message: {
						content: [
							{ type: "text", text: longText.slice(40, 100) },
						],
					},
				},
				{
					type: "result",
					subtype: "success",
					result: "done",
					num_turns: 1,
					total_cost_usd: 0,
				},
			]) as any,
		);

		const session = new AgentSession(makeAgent(), {}, eventBus, {
			agentName: "test-agent",
			prompt: "hello",
			traceId: "trace-chunk",
		});

		await session.run();

		// The text fragments should be emitted as a single chunked message (flushed at end of run)
		const messageEvents = events.filter(
			(e) =>
				e.type === "agent:message" &&
				(e.payload as any).chunked === true,
		);
		expect(messageEvents.length).toBe(1);
		expect((messageEvents[0].payload as any).text).toBe(longText);
	});

	it("splits text over BLOCK_MAX_CHARS at paragraph boundary", async () => {
		// Create text that exceeds BLOCK_MAX_CHARS with a paragraph break
		const part1 = "A".repeat(1200);
		const part2 = "B".repeat(1200);
		const fullText = part1 + "\n\n" + part2;
		// Total = 2402 chars, > BLOCK_MAX_CHARS(2000), with \n\n at position 1200

		mockedQuery.mockReturnValue(
			mockQueryStream([
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: fullText }],
					},
				},
				{
					type: "result",
					subtype: "success",
					result: "done",
					num_turns: 1,
					total_cost_usd: 0,
				},
			]) as any,
		);

		const session = new AgentSession(makeAgent(), {}, eventBus, {
			agentName: "test-agent",
			prompt: "hello",
			traceId: "trace-split",
		});

		await session.run();

		const messageEvents = events.filter(
			(e) =>
				e.type === "agent:message" &&
				(e.payload as any).chunked === true,
		);
		// Should be split into 2 blocks at the \n\n boundary
		expect(messageEvents.length).toBe(2);
		expect((messageEvents[0].payload as any).text).toBe(part1 + "\n\n");
		expect((messageEvents[1].payload as any).text).toBe(part2);
	});
});
