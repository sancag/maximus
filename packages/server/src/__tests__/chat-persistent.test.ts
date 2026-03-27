import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { chatRoutes } from "../routes/chat.js";
import type { AgentEngine } from "@maximus/core";
import type { AgentEvent } from "@maximus/shared";

// --- Mock PersistentSession ---
function createMockSession() {
	const eventHandlers: Array<(event: AgentEvent) => void> = [];
	return {
		send: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		getSessionId: vi.fn().mockReturnValue("test-session-id"),
		isActive: vi.fn().mockReturnValue(true),
		onEvent: vi.fn((handler: (event: AgentEvent) => void) => {
			eventHandlers.push(handler);
			return () => {
				const idx = eventHandlers.indexOf(handler);
				if (idx >= 0) eventHandlers.splice(idx, 1);
			};
		}),
		start: vi.fn().mockResolvedValue(undefined),
		_emit(event: AgentEvent) {
			for (const h of eventHandlers) h(event);
		},
		_handlers: eventHandlers,
	};
}

// --- Mock SessionManager ---
function createMockSessionManager(session: ReturnType<typeof createMockSession>) {
	return {
		getOrCreateSession: vi.fn().mockResolvedValue(session),
		closeSession: vi.fn().mockResolvedValue(undefined),
		hasActiveSession: vi.fn().mockReturnValue(true),
	};
}

// --- Mock AgentEngine ---
function createMockEngine(sessionManager: ReturnType<typeof createMockSessionManager>) {
	const mockAgent = {
		name: "orchestrator",
		description: "Test orchestrator",
		model: "sonnet",
		maxTurns: 25,
		skills: [],
		prompt: "You are a test agent.",
		filePath: "/agents/orchestrator.md",
	};

	return {
		getSessionManager: vi.fn().mockReturnValue(sessionManager),
		getAgentRegistry: vi.fn().mockReturnValue({
			getAll: () => [mockAgent],
		}),
		getEventBus: vi.fn().mockReturnValue({
			on: vi.fn().mockReturnValue(() => {}),
			onAny: vi.fn().mockReturnValue(() => {}),
		}),
		runAgent: vi.fn().mockResolvedValue({
			output: "test response",
			sessionId: "one-shot-session",
		}),
	} as unknown as AgentEngine;
}

let server: Server;
let baseUrl: string;
let mockSession: ReturnType<typeof createMockSession>;
let mockSessionManager: ReturnType<typeof createMockSessionManager>;
let mockEngine: AgentEngine;

beforeAll(async () => {
	mockSession = createMockSession();
	mockSessionManager = createMockSessionManager(mockSession);
	mockEngine = createMockEngine(mockSessionManager);

	const app = express();
	app.use(express.json());
	app.use("/api/chat", chatRoutes(mockEngine));

	server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /api/chat/stream", () => {
	it("returns SSE headers and connected event", async () => {
		const res = await fetch(`${baseUrl}/api/chat/stream`);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(res.headers.get("cache-control")).toBe("no-cache");

		// Read the first SSE line (connected event)
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		const { value } = await reader.read();
		const text = decoder.decode(value);

		expect(text).toContain("data:");
		const jsonStr = text.split("data: ")[1]?.split("\n")[0];
		const data = JSON.parse(jsonStr!);
		expect(data.type).toBe("connected");
		expect(data.sessionId).toBe("test-session-id");

		reader.cancel();
	});

	it("calls getSessionManager().getOrCreateSession()", async () => {
		const res = await fetch(`${baseUrl}/api/chat/stream`);
		// Read at least one chunk to ensure handler executed
		const reader = res.body!.getReader();
		await reader.read();
		reader.cancel();

		expect(mockEngine.getSessionManager).toHaveBeenCalled();
		expect(mockSessionManager.getOrCreateSession).toHaveBeenCalled();
	});

	it("streams agent:message events as chunk SSE data", async () => {
		const res = await fetch(`${baseUrl}/api/chat/stream`);
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();

		// Read connected event first
		await reader.read();

		// Emit an agent:message event
		mockSession._emit({
			id: "evt-1",
			timestamp: Date.now(),
			sessionId: "test-session-id",
			agentName: "orchestrator",
			type: "agent:message",
			payload: { text: "Hello world" },
		});

		// Give a tick for the event to propagate
		await new Promise((r) => setTimeout(r, 50));

		const { value } = await reader.read();
		const text = decoder.decode(value);
		const jsonStr = text.split("data: ")[1]?.split("\n")[0];
		const data = JSON.parse(jsonStr!);

		expect(data.type).toBe("chunk");
		expect(data.content).toBe("Hello world");

		reader.cancel();
	});

	it("streams session:end events as done SSE data", async () => {
		const res = await fetch(`${baseUrl}/api/chat/stream`);
		const reader = res.body!.getReader();

		// Read connected event
		await reader.read();

		mockSession._emit({
			id: "evt-2",
			timestamp: Date.now(),
			sessionId: "test-session-id",
			agentName: "orchestrator",
			type: "session:end",
			payload: { success: true },
		});

		await new Promise((r) => setTimeout(r, 50));

		const decoder = new TextDecoder();
		const { value } = await reader.read();
		const text = decoder.decode(value);
		const jsonStr = text.split("data: ")[1]?.split("\n")[0];
		const data = JSON.parse(jsonStr!);

		expect(data.type).toBe("done");

		reader.cancel();
	});
});

describe("POST /api/chat/message", () => {
	it("returns 200 with accepted status and calls session.send()", async () => {
		mockSession.send.mockClear();

		const res = await fetch(`${baseUrl}/api/chat/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello agent" }),
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("accepted");
		expect(data.sessionId).toBe("test-session-id");
		expect(mockSession.send).toHaveBeenCalled();
		// The send call should include the message (possibly with context prefix)
		const sentMessage = mockSession.send.mock.calls[0][0] as string;
		expect(sentMessage).toContain("hello agent");
	});

	it("returns 400 when message field is missing", async () => {
		const res = await fetch(`${baseUrl}/api/chat/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toContain("message");
	});

	it("returns 400 when message is not a string", async () => {
		const res = await fetch(`${baseUrl}/api/chat/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: 123 }),
		});

		expect(res.status).toBe(400);
	});
});

describe("POST /api/chat (existing one-shot)", () => {
	it("still works for backward compatibility", async () => {
		const res = await fetch(`${baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "one-shot test" }),
		});

		// Should return SSE stream (existing behavior)
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
	});
});
