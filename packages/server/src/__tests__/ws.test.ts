import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	createFrame,
	createConnectedFrame,
	serializeFrame,
	resetSeq,
} from "../ws/frames.js";
import type { WebSocketFrame } from "../ws/frames.js";
import { EventBridge } from "../ws/bridge.js";
import { EventBus } from "@maximus/core";
import type { AgentEvent } from "@maximus/shared";

function makeEvent(
	type: AgentEvent["type"] = "agent:message",
	overrides: Partial<AgentEvent> = {},
): AgentEvent {
	return {
		id: "evt-1",
		timestamp: Date.now(),
		sessionId: "sess-1",
		agentName: "researcher",
		type,
		payload: { content: "hello" },
		traceId: "trace-1",
		...overrides,
	};
}

function makeMockWs(readyState = 1, bufferedAmount = 0) {
	return {
		readyState,
		bufferedAmount,
		send: vi.fn(),
		on: vi.fn(),
	};
}

function makeMockWss(clients: any[] = []) {
	return {
		clients: new Set(clients),
	};
}

describe("frames", () => {
	beforeEach(() => {
		resetSeq();
	});

	it("createFrame produces correct structure", () => {
		const event = makeEvent();
		const frame = createFrame(event);

		expect(frame.type).toBe("event");
		expect(frame.event).toBe("agent:message");
		expect(frame.payload).toEqual(event as unknown as Record<string, unknown>);
		expect(frame.seq).toBe(1);
	});

	it("seq increments on each call", () => {
		const frame1 = createFrame(makeEvent());
		const frame2 = createFrame(makeEvent());
		const frame3 = createFrame(makeEvent());

		expect(frame1.seq).toBe(1);
		expect(frame2.seq).toBe(2);
		expect(frame3.seq).toBe(3);
	});

	it("frame serializes to valid JSON", () => {
		const frame = createFrame(makeEvent());
		const json = serializeFrame(frame);
		const parsed = JSON.parse(json) as WebSocketFrame;

		expect(parsed.type).toBe("event");
		expect(parsed.seq).toBe(1);
		expect(parsed.event).toBe("agent:message");
	});

	it("createConnectedFrame returns seq 0", () => {
		const frame = createConnectedFrame();
		expect(frame.type).toBe("connected");
		expect(frame.seq).toBe(0);
		expect(frame.payload.message).toContain("Connected");
	});
});

describe("EventBridge", () => {
	beforeEach(() => {
		resetSeq();
	});

	it("subscribes to EventBus.onAny on construction", () => {
		const bus = new EventBus();
		const onAnySpy = vi.spyOn(bus, "onAny");
		const wss = makeMockWss();

		const bridge = new EventBridge(bus, wss as any);
		expect(onAnySpy).toHaveBeenCalledOnce();
		bridge.destroy();
	});

	it("broadcasts events to all connected clients", () => {
		const bus = new EventBus();
		const client1 = makeMockWs();
		const client2 = makeMockWs();
		const wss = makeMockWss([client1, client2]);

		const bridge = new EventBridge(bus, wss as any);

		const event = makeEvent();
		bus.emit(event);

		expect(client1.send).toHaveBeenCalledOnce();
		expect(client2.send).toHaveBeenCalledOnce();

		// Verify frame content
		const sentFrame = JSON.parse(client1.send.mock.calls[0][0] as string);
		expect(sentFrame.type).toBe("event");
		expect(sentFrame.event).toBe("agent:message");
		expect(sentFrame.seq).toBe(1);

		bridge.destroy();
	});

	it("skips clients with readyState !== OPEN", () => {
		const bus = new EventBus();
		const openClient = makeMockWs(1); // OPEN
		const closedClient = makeMockWs(3); // CLOSED
		const wss = makeMockWss([openClient, closedClient]);

		const bridge = new EventBridge(bus, wss as any);
		bus.emit(makeEvent());

		expect(openClient.send).toHaveBeenCalledOnce();
		expect(closedClient.send).not.toHaveBeenCalled();

		bridge.destroy();
	});

	it("destroy() unsubscribes from EventBus", () => {
		const bus = new EventBus();
		const client = makeMockWs();
		const wss = makeMockWss([client]);

		const bridge = new EventBridge(bus, wss as any);
		bridge.destroy();

		// Emit after destroy -- client should not receive
		bus.emit(makeEvent());
		expect(client.send).not.toHaveBeenCalled();
	});

	it("skips clients with high backpressure", () => {
		const bus = new EventBus();
		const normalClient = makeMockWs(1, 0);
		const backpressuredClient = makeMockWs(1, 1024 * 128); // 128KB > 64KB threshold
		const wss = makeMockWss([normalClient, backpressuredClient]);

		const bridge = new EventBridge(bus, wss as any);
		bus.emit(makeEvent());

		expect(normalClient.send).toHaveBeenCalledOnce();
		expect(backpressuredClient.send).not.toHaveBeenCalled();

		bridge.destroy();
	});
});

describe("createWsHandler", () => {
	it("sends connected frame on new connection", async () => {
		// Dynamically import to avoid module-level pino side effects
		const { createWsHandler } = await import("../ws/handler.js");
		const mockEngine = {
			getAgentRegistry: () => ({ getAll: () => [{ name: "a" }, { name: "b" }] }),
			getTaskStore: () => ({ getAll: () => [] }),
		};
		const handler = createWsHandler(mockEngine as any, Date.now() - 5000);

		const mockWs = {
			send: vi.fn(),
			on: vi.fn(),
		};

		handler(mockWs as any);

		expect(mockWs.send).toHaveBeenCalledOnce();
		const sentFrame = JSON.parse(mockWs.send.mock.calls[0][0] as string);
		expect(sentFrame.type).toBe("connected");
		expect(sentFrame.seq).toBe(0);
		expect(sentFrame.payload.agentCount).toBe(2);
		expect(sentFrame.payload.activeTasks).toBe(0);

		// Verify event listeners registered
		const onCalls = mockWs.on.mock.calls.map((c: any[]) => c[0]);
		expect(onCalls).toContain("close");
		expect(onCalls).toContain("error");
	});
});
