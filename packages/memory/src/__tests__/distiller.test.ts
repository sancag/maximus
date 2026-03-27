import { describe, it, expect } from "vitest";
import { EpisodeDistiller } from "../trace/distiller.js";
import type { AgentEvent, Episode } from "@maximus/shared";
import type { EpisodeStore } from "../sqlite/episodes.js";

let _idCounter = 0;

function makeEvent(
	type: AgentEvent["type"],
	payload: Record<string, unknown> = {},
	overrides: Partial<AgentEvent> = {},
): AgentEvent {
	return {
		id: `evt-${++_idCounter}`,
		timestamp: 1000 + _idCounter * 100,
		sessionId: "sess-1",
		agentName: "test-agent",
		type,
		payload,
		...overrides,
	};
}

describe("EpisodeDistiller", () => {
	const distiller = new EpisodeDistiller();

	it('distill produces "success" outcome when agent:completion present', () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Test task" }),
			makeEvent("agent:message"),
			makeEvent("agent:message"),
			makeEvent("agent:completion"),
			makeEvent("session:end"),
		];

		const episode = distiller.distill("test-agent", events);

		expect(episode.outcome).toBe("success");
		expect(episode.taskDescription).toBe("Test task");
	});

	it('distill produces "failure" outcome when agent:error present', () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Failing task" }),
			makeEvent("agent:error", { error: "Something broke" }),
			makeEvent("session:end"),
		];

		const episode = distiller.distill("test-agent", events);

		expect(episode.outcome).toBe("failure");
		expect(episode.failurePatterns).toContain("Something broke");
	});

	it('distill produces "partial" outcome when no completion or error', () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Partial task" }),
			makeEvent("agent:message"),
			makeEvent("session:end"),
		];

		const episode = distiller.distill("test-agent", events);
		expect(episode.outcome).toBe("partial");
	});

	it("distill extracts unique toolsUsed from agent:tool_call events", () => {
		const events: AgentEvent[] = [
			makeEvent("session:start"),
			makeEvent("agent:tool_call", { tool: "bash" }),
			makeEvent("agent:tool_result", { tool: "bash", result: "ok", success: true }),
			makeEvent("agent:tool_call", { tool: "bash" }),
			makeEvent("agent:tool_result", { tool: "bash", result: "ok2", success: true }),
			makeEvent("agent:tool_call", { tool: "read_file" }),
			makeEvent("agent:tool_result", { tool: "read_file", result: "contents", success: true }),
			makeEvent("agent:completion"),
			makeEvent("session:end"),
		];

		const episode = distiller.distill("test-agent", events);

		expect(episode.toolsUsed).toHaveLength(2);
		expect(episode.toolsUsed).toContain("bash");
		expect(episode.toolsUsed).toContain("read_file");
	});

	it("distill computes turnCount from agent:message events", () => {
		const events: AgentEvent[] = [
			makeEvent("session:start"),
			makeEvent("agent:message"),
			makeEvent("agent:message"),
			makeEvent("agent:message"),
			makeEvent("agent:message"),
			makeEvent("session:end"),
		];

		const episode = distiller.distill("test-agent", events);
		expect(episode.turnCount).toBe(4);
	});

	it("distill computes durationMs from first to last event timestamp", () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", {}, { timestamp: 1000 }),
			makeEvent("agent:message", {}, { timestamp: 3000 }),
			makeEvent("session:end", {}, { timestamp: 6000 }),
		];

		const episode = distiller.distill("test-agent", events);
		expect(episode.durationMs).toBe(5000);
	});

	it("distill adds efficiency strategy for fast success with no tool lessons", () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Quick task" }),
			makeEvent("agent:message"),
			makeEvent("agent:completion"),
			makeEvent("session:end"),
		];

		const episode = distiller.distill("test-agent", events);

		expect(episode.outcome).toBe("success");
		expect(episode.turnCount).toBeLessThan(5);
		expect(episode.effectiveStrategies).toContain(
			"Completed efficiently in few turns",
		);
	});

	it("distill generates tags including agentName and outcome", () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Tag test" }),
			makeEvent("agent:completion"),
			makeEvent("session:end"),
		];

		const episode = distiller.distill("test-agent", events);

		expect(episode.tags).toContain("test-agent");
		expect(episode.tags).toContain(episode.outcome);
	});

	it("extracts cost from agent:completion when session:end has no cost", () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Cost test" }),
			makeEvent("agent:message"),
			makeEvent("agent:completion", { cost: 0.042 }),
			makeEvent("session:end", {}),
		];

		const episode = distiller.distill("test-agent", events);

		expect(episode.costUsd).toBe(0.042);
	});

	// --- New tool-pair extraction tests ---

	it("extracts lessons from new-format tool call/result pairs", () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Check balance" }),
			makeEvent("agent:tool_call", { tool: "get_balance", input: { account: "main" } }),
			makeEvent("agent:tool_result", { tool: "get_balance", result: "Balance: $500", success: true }),
			makeEvent("agent:completion"),
			makeEvent("session:end"),
		];

		const episode = distiller.distill("test-agent", events);

		expect(episode.lessonsLearned.length).toBeGreaterThanOrEqual(1);
		const lesson = episode.lessonsLearned.find(
			(l) => l.includes("get_balance") && l.includes("$500"),
		);
		expect(lesson).toBeDefined();
		expect(lesson).toMatch(/^Called get_balance -> Balance: \$500$/);
	});

	it("handles old-format tool calls without results (backward compat)", () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Place order" }),
			makeEvent("agent:tool_call", {
				toolUse: { name: "place_order", input: { qty: 1 } },
			}),
			// No agent:tool_result event - old format
			makeEvent("agent:completion"),
			makeEvent("session:end"),
		];

		// Must not crash
		const episode = distiller.distill("test-agent", events);

		expect(episode.toolsUsed).toContain("place_order");
		expect(episode.lessonsLearned.length).toBeGreaterThanOrEqual(1);
		expect(episode.lessonsLearned).toContain("Used place_order");
	});

	it("captures failure patterns from failed tool results", () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Trade" }),
			makeEvent("agent:tool_call", { tool: "place_order", input: { qty: 10 } }),
			makeEvent("agent:tool_result", {
				tool: "place_order",
				success: false,
				error: "Insufficient margin",
			}),
			makeEvent("agent:error", { error: "Order failed" }),
			makeEvent("session:end"),
		];

		const episode = distiller.distill("test-agent", events);

		expect(episode.failurePatterns).toContain("Insufficient margin");
		expect(episode.failurePatterns).toContain("Order failed");
		// Lesson should indicate the failure
		expect(
			episode.lessonsLearned.some((l) => l.includes("place_order failed")),
		).toBe(true);
	});

	it("produces >50% non-empty lessons for realistic tool-heavy traces", () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Research task" }),
		];

		// Create 5 tool call/result pairs
		const tools = ["get_balance", "get_positions", "get_orders", "get_ticker", "get_funding"];
		for (const tool of tools) {
			events.push(
				makeEvent("agent:tool_call", { tool, input: {} }),
				makeEvent("agent:tool_result", {
					tool,
					result: `Result for ${tool}`,
					success: true,
				}),
			);
		}

		events.push(
			makeEvent("agent:completion"),
			makeEvent("session:end"),
		);

		const episode = distiller.distill("test-agent", events);

		// At least 50% of pairs (3 out of 5) should produce lessons
		expect(episode.lessonsLearned.length).toBeGreaterThanOrEqual(3);
		// Actually all 5 should produce lessons
		expect(episode.lessonsLearned.length).toBe(5);
	});

	it("produces empty lessonsLearned when no tool events present", () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Simple chat" }),
			makeEvent("agent:message"),
			makeEvent("agent:completion"),
			makeEvent("session:end"),
		];

		const episode = distiller.distill("test-agent", events);

		expect(episode.lessonsLearned).toEqual([]);
	});

	it("detects effective sequences from 3+ consecutive successful tool pairs", () => {
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Pipeline" }),
			makeEvent("agent:tool_call", { tool: "fetch_data", input: {} }),
			makeEvent("agent:tool_result", { tool: "fetch_data", result: "data", success: true }),
			makeEvent("agent:tool_call", { tool: "transform", input: {} }),
			makeEvent("agent:tool_result", { tool: "transform", result: "transformed", success: true }),
			makeEvent("agent:tool_call", { tool: "save", input: {} }),
			makeEvent("agent:tool_result", { tool: "save", result: "saved", success: true }),
			makeEvent("agent:completion"),
			makeEvent("session:end"),
		];

		const episode = distiller.distill("test-agent", events);

		expect(episode.effectiveStrategies).toContain(
			"Effective sequence: fetch_data -> transform -> save",
		);
	});

	it("truncates long tool results to 150 chars in lessons", () => {
		const longResult = "X".repeat(300);
		const events: AgentEvent[] = [
			makeEvent("session:start", { task: "Long result" }),
			makeEvent("agent:tool_call", { tool: "big_query", input: {} }),
			makeEvent("agent:tool_result", {
				tool: "big_query",
				result: longResult,
				success: true,
			}),
			makeEvent("agent:completion"),
			makeEvent("session:end"),
		];

		const episode = distiller.distill("test-agent", events);

		const lesson = episode.lessonsLearned.find((l) => l.includes("big_query"));
		expect(lesson).toBeDefined();
		// "Called big_query -> " + 150 chars + "..."
		expect(lesson!.length).toBeLessThanOrEqual(200);
		expect(lesson!).toContain("...");
	});

	describe("regression detection", () => {
		function makeMockEpisodeStore(episodes: Episode[]): EpisodeStore {
			return {
				getByAgent: (_agentName: string, _limit?: number) => episodes,
			} as unknown as EpisodeStore;
		}

		it("flags REGRESSION for failed task with prior success", () => {
			const mockStore = makeMockEpisodeStore([
				{
					id: "ep-1",
					agentName: "test-agent",
					timestamp: Date.now() - 86_400_000,
					taskDescription: "check balances",
					outcome: "success",
					lessonsLearned: [],
					effectiveStrategies: [],
					failurePatterns: [],
					toolsUsed: [],
					tags: [],
					utilityScore: 0,
					retrievalCount: 0,
				},
			]);

			const d = new EpisodeDistiller(mockStore);
			const events: AgentEvent[] = [
				makeEvent("session:start", { task: "check balances" }),
				makeEvent("agent:error", { error: "Connection timeout" }),
				makeEvent("session:end"),
			];

			const episode = d.distill("test-agent", events);

			expect(episode.failurePatterns[0]).toMatch(/^REGRESSION:/);
			expect(episode.failurePatterns[0]).toContain("check balances");
		});

		it("does not flag regression for new task type", () => {
			const mockStore = makeMockEpisodeStore([
				{
					id: "ep-1",
					agentName: "test-agent",
					timestamp: Date.now() - 86_400_000,
					taskDescription: "check balances",
					outcome: "success",
					lessonsLearned: [],
					effectiveStrategies: [],
					failurePatterns: [],
					toolsUsed: [],
					tags: [],
					utilityScore: 0,
					retrievalCount: 0,
				},
			]);

			const d = new EpisodeDistiller(mockStore);
			const events: AgentEvent[] = [
				makeEvent("session:start", { task: "place order" }),
				makeEvent("agent:error", { error: "Order failed" }),
				makeEvent("session:end"),
			];

			const episode = d.distill("test-agent", events);

			const hasRegression = episode.failurePatterns.some((p) =>
				p.startsWith("REGRESSION:"),
			);
			expect(hasRegression).toBe(false);
		});

		it("works without episodeStore (backward compat)", () => {
			const d = new EpisodeDistiller();
			const events: AgentEvent[] = [
				makeEvent("session:start", { task: "failing task" }),
				makeEvent("agent:error", { error: "Something broke" }),
				makeEvent("session:end"),
			];

			// Should not crash
			const episode = d.distill("test-agent", events);
			expect(episode.outcome).toBe("failure");
			const hasRegression = episode.failurePatterns.some((p) =>
				p.startsWith("REGRESSION:"),
			);
			expect(hasRegression).toBe(false);
		});
	});
});
