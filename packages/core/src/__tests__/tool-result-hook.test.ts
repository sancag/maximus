import { describe, it, expect, beforeEach } from "vitest";
import type { AgentEvent } from "@maximus/shared";
import { EventBus } from "../events/bus.js";
import { createHooks } from "../runtime/hooks.js";

describe("tool result hooks", () => {
	let eventBus: EventBus;
	let emittedEvents: AgentEvent[];

	beforeEach(() => {
		eventBus = new EventBus();
		emittedEvents = [];
		eventBus.onAny((event: AgentEvent) => {
			emittedEvents.push(event);
		});
	});

	describe("toolResultHook (PostToolUse)", () => {
		it("emits agent:tool_result with success=true, tool name, and result", async () => {
			const hooks = createHooks(eventBus, "test-agent", "sess-1", "trace-1", 2000);
			const postToolUseHooks = hooks.PostToolUse[0].hooks;
			// toolResultHook is the first hook in PostToolUse
			const toolResultHook = postToolUseHooks[0];

			const result = await toolResultHook(
				{
					hook_event_name: "PostToolUse",
					tool_name: "get_balance",
					tool_input: { account: "main" },
					tool_response: "Balance: $500",
					tool_use_id: "tu_123",
				},
				undefined,
				undefined,
			);

			expect(result).toEqual({ continue: true });
			expect(emittedEvents).toHaveLength(1);

			const event = emittedEvents[0];
			expect(event.type).toBe("agent:tool_result");
			expect(event.agentName).toBe("test-agent");
			expect(event.sessionId).toBe("sess-1");
			expect(event.traceId).toBe("trace-1");
			expect(event.payload.tool).toBe("get_balance");
			expect(event.payload.success).toBe(true);
			expect(event.payload.result).toBe("Balance: $500");
			expect(event.payload.toolUseId).toBe("tu_123");
			expect(event.payload.input).toEqual({ account: "main" });
		});

		it("does NOT truncate result shorter than maxToolResultChars", async () => {
			const hooks = createHooks(eventBus, "test-agent", "sess-1", "trace-1", 2000);
			const toolResultHook = hooks.PostToolUse[0].hooks[0];

			await toolResultHook(
				{
					hook_event_name: "PostToolUse",
					tool_name: "short_tool",
					tool_input: {},
					tool_response: "Short response",
					tool_use_id: "tu_short",
				},
				undefined,
				undefined,
			);

			const event = emittedEvents[0];
			expect(event.payload.result).toBe("Short response");
			expect((event.payload.result as string).includes("truncated")).toBe(false);
		});

		it("truncates result longer than maxToolResultChars with suffix", async () => {
			const maxChars = 100;
			const hooks = createHooks(eventBus, "test-agent", "sess-1", "trace-1", maxChars);
			const toolResultHook = hooks.PostToolUse[0].hooks[0];

			const longResponse = "x".repeat(3000);
			await toolResultHook(
				{
					hook_event_name: "PostToolUse",
					tool_name: "verbose_tool",
					tool_input: {},
					tool_response: longResponse,
					tool_use_id: "tu_long",
				},
				undefined,
				undefined,
			);

			const event = emittedEvents[0];
			const result = event.payload.result as string;
			// Should be maxChars + '...[truncated]' suffix (14 chars)
			expect(result.length).toBeLessThanOrEqual(maxChars + 14);
			expect(result.endsWith("...[truncated]")).toBe(true);
		});

		it("stringifies object tool_response before truncation", async () => {
			const hooks = createHooks(eventBus, "test-agent", "sess-1", "trace-1", 2000);
			const toolResultHook = hooks.PostToolUse[0].hooks[0];

			await toolResultHook(
				{
					hook_event_name: "PostToolUse",
					tool_name: "json_tool",
					tool_input: {},
					tool_response: { balance: 500, currency: "USD" },
					tool_use_id: "tu_json",
				},
				undefined,
				undefined,
			);

			const event = emittedEvents[0];
			expect(typeof event.payload.result).toBe("string");
			expect(event.payload.result).toContain("balance");
		});
	});

	describe("toolFailureHook (PostToolUseFailure)", () => {
		it("emits agent:tool_result with success=false, tool name, and error", async () => {
			const hooks = createHooks(eventBus, "test-agent", "sess-1", "trace-1", 2000);
			const postToolUseFailureHooks = hooks.PostToolUseFailure[0].hooks;
			const toolFailureHook = postToolUseFailureHooks[0];

			const result = await toolFailureHook(
				{
					hook_event_name: "PostToolUseFailure",
					tool_name: "place_order",
					tool_input: { symbol: "AAPL", qty: 10 },
					error: "Insufficient margin",
					tool_use_id: "tu_fail",
				},
				undefined,
				undefined,
			);

			expect(result).toEqual({ continue: true });
			expect(emittedEvents).toHaveLength(1);

			const event = emittedEvents[0];
			expect(event.type).toBe("agent:tool_result");
			expect(event.agentName).toBe("test-agent");
			expect(event.payload.tool).toBe("place_order");
			expect(event.payload.success).toBe(false);
			expect(event.payload.error).toBe("Insufficient margin");
			expect(event.payload.toolUseId).toBe("tu_fail");
			expect(event.payload.input).toEqual({ symbol: "AAPL", qty: 10 });
		});
	});
});
