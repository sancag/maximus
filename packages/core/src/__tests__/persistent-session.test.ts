import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- AsyncChannel Tests ---

describe("AsyncChannel", () => {
	let AsyncChannel: typeof import("../runtime/async-channel.js").AsyncChannel;

	beforeEach(async () => {
		const mod = await import("../runtime/async-channel.js");
		AsyncChannel = mod.AsyncChannel;
	});

	it("push then read delivers value in order", async () => {
		const ch = new AsyncChannel<number>();
		ch.push(1);
		ch.push(2);
		ch.push(3);

		const iter = ch[Symbol.asyncIterator]();
		const r1 = await iter.next();
		const r2 = await iter.next();
		const r3 = await iter.next();

		expect(r1).toEqual({ value: 1, done: false });
		expect(r2).toEqual({ value: 2, done: false });
		expect(r3).toEqual({ value: 3, done: false });
	});

	it("read then push resolves the waiting reader", async () => {
		const ch = new AsyncChannel<string>();
		const iter = ch[Symbol.asyncIterator]();

		// Start reading (will wait)
		const promise = iter.next();
		// Push a value
		ch.push("hello");

		const result = await promise;
		expect(result).toEqual({ value: "hello", done: false });
	});

	it("close terminates iteration", async () => {
		const ch = new AsyncChannel<number>();
		ch.push(1);
		ch.close();

		const iter = ch[Symbol.asyncIterator]();
		const r1 = await iter.next();
		const r2 = await iter.next();

		expect(r1).toEqual({ value: 1, done: false });
		expect(r2.done).toBe(true);
	});

	it("close resolves a pending reader with done", async () => {
		const ch = new AsyncChannel<number>();
		const iter = ch[Symbol.asyncIterator]();

		const promise = iter.next();
		ch.close();

		const result = await promise;
		expect(result.done).toBe(true);
	});

	it("push after close throws", () => {
		const ch = new AsyncChannel<number>();
		ch.close();
		expect(() => ch.push(1)).toThrow("Channel is closed");
	});

	it("works with for-await-of", async () => {
		const ch = new AsyncChannel<number>();
		ch.push(10);
		ch.push(20);
		ch.close();

		const values: number[] = [];
		for await (const v of ch) {
			values.push(v);
		}
		expect(values).toEqual([10, 20]);
	});
});

// --- PersistentSession Tests ---

// Mock the SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
	return {
		query: vi.fn(),
		createSdkMcpServer: vi.fn(),
		tool: vi.fn(),
	};
});

// Mock nanoid
vi.mock("nanoid", () => ({
	nanoid: () => "test-id-123",
}));

// Mock hooks
vi.mock("../runtime/hooks.js", () => ({
	createHooks: () => ({ PostToolUse: [] }),
	filterEnvForSdk: (env: Record<string, string>) => env,
}));

// Mock vault
vi.mock("@maximus/vault", () => ({
	createSanitizerHook: () => vi.fn(),
}));

describe("PersistentSession", () => {
	let PersistentSession: typeof import("../runtime/persistent-session.js").PersistentSession;
	let queryMock: ReturnType<typeof vi.fn>;
	let eventBus: any;

	const fakeAgentDef = {
		name: "orchestrator",
		prompt: "You are an orchestrator",
		description: "Test orchestrator",
		model: "sonnet" as const,
		skills: [],
		maxTurns: 10,
	};

	beforeEach(async () => {
		vi.clearAllMocks();

		const sdkMod = await import("@anthropic-ai/claude-agent-sdk");
		queryMock = sdkMod.query as ReturnType<typeof vi.fn>;

		const { EventBus } = await import("../events/bus.js");
		eventBus = new EventBus();

		const mod = await import("../runtime/persistent-session.js");
		PersistentSession = mod.PersistentSession;
	});

	function createMockQuery(messages: Record<string, any>[]) {
		let index = 0;
		const mockQuery = {
			sessionId: "sdk-session-abc",
			[Symbol.asyncIterator]() {
				return {
					next: async () => {
						if (index < messages.length) {
							return { value: messages[index++], done: false };
						}
						// Wait indefinitely (simulates open query)
						return new Promise<IteratorResult<any>>(() => {});
					},
				};
			},
			abort: vi.fn(),
		};
		return mockQuery;
	}

	function createFiniteMockQuery(messages: Record<string, any>[]) {
		let index = 0;
		const mockQuery = {
			sessionId: "sdk-session-abc",
			[Symbol.asyncIterator]() {
				return {
					next: async () => {
						if (index < messages.length) {
							return { value: messages[index++], done: false };
						}
						return { value: undefined, done: true };
					},
				};
			},
			abort: vi.fn(),
		};
		return mockQuery;
	}

	it("start() emits session:start event", async () => {
		const mockQ = createMockQuery([]);
		queryMock.mockReturnValue(mockQ);

		const events: any[] = [];
		eventBus.on("session:start", (e: any) => events.push(e));

		const session = new PersistentSession(
			fakeAgentDef as any,
			{},
			eventBus,
			{ agentName: "orchestrator", sessionId: "sess-1" },
		);
		await session.start();

		expect(events.length).toBe(1);
		expect(events[0].type).toBe("session:start");
		expect(events[0].agentName).toBe("orchestrator");

		await session.close();
	});

	it("send() pushes a user message to the input channel", async () => {
		// Track the prompt passed to query()
		let capturedPrompt: any;
		queryMock.mockImplementation((params: any) => {
			capturedPrompt = params.prompt;
			return createMockQuery([]);
		});

		const session = new PersistentSession(
			fakeAgentDef as any,
			{},
			eventBus,
			{ agentName: "orchestrator" },
		);
		await session.start();
		await session.send("Hello agent");

		// The prompt should be the AsyncChannel; read from it
		const iter = capturedPrompt[Symbol.asyncIterator]();
		const result = await iter.next();
		expect(result.done).toBe(false);
		expect(result.value.type).toBe("user");
		expect(result.value.message.role).toBe("user");
		expect(result.value.message.content).toBe("Hello agent");

		await session.close();
	});

	it("processOutput emits agent:message events from SDK output", async () => {
		const mockMessages = [
			{
				type: "assistant",
				message: {
					content: [{ type: "text", text: "Hello from agent" }],
				},
			},
		];
		const mockQ = createFiniteMockQuery(mockMessages);
		queryMock.mockReturnValue(mockQ);

		const events: any[] = [];
		eventBus.on("agent:message", (e: any) => events.push(e));

		const session = new PersistentSession(
			fakeAgentDef as any,
			{},
			eventBus,
			{ agentName: "orchestrator" },
		);
		await session.start();

		// Wait a tick for processOutput to consume
		await new Promise((r) => setTimeout(r, 250));

		// The session should have emitted the text block (flushed on processOutput completion)
		expect(events.length).toBeGreaterThanOrEqual(1);
		const textEvent = events.find(
			(e) => e.payload?.text === "Hello from agent",
		);
		expect(textEvent).toBeDefined();
		expect(textEvent.type).toBe("agent:message");
	});

	it("close() emits session:end event", async () => {
		const mockQ = createMockQuery([]);
		queryMock.mockReturnValue(mockQ);

		const events: any[] = [];
		eventBus.on("session:end", (e: any) => events.push(e));

		const session = new PersistentSession(
			fakeAgentDef as any,
			{},
			eventBus,
			{ agentName: "orchestrator" },
		);
		await session.start();
		await session.close();

		expect(events.length).toBe(1);
		expect(events[0].type).toBe("session:end");
	});

	it("getSessionId() returns configured session ID", async () => {
		const mockQ = createMockQuery([]);
		queryMock.mockReturnValue(mockQ);

		const session = new PersistentSession(
			fakeAgentDef as any,
			{},
			eventBus,
			{ agentName: "orchestrator", sessionId: "custom-id" },
		);

		expect(session.getSessionId()).toBe("custom-id");
	});

	it("isActive() returns true after start, false after close", async () => {
		const mockQ = createMockQuery([]);
		queryMock.mockReturnValue(mockQ);

		const session = new PersistentSession(
			fakeAgentDef as any,
			{},
			eventBus,
			{ agentName: "orchestrator" },
		);

		expect(session.isActive()).toBe(false);
		await session.start();
		expect(session.isActive()).toBe(true);
		await session.close();
		expect(session.isActive()).toBe(false);
	});

	it("onEvent() subscribes to events matching this session", async () => {
		const mockQ = createMockQuery([]);
		queryMock.mockReturnValue(mockQ);

		const session = new PersistentSession(
			fakeAgentDef as any,
			{},
			eventBus,
			{ agentName: "orchestrator", sessionId: "match-me" },
		);
		await session.start();

		const received: any[] = [];
		session.onEvent((e) => received.push(e));

		// Emit matching event
		eventBus.emit({
			id: "1",
			timestamp: Date.now(),
			sessionId: "match-me",
			agentName: "orchestrator",
			type: "agent:message",
			payload: { text: "hello" },
		});

		// Emit non-matching event
		eventBus.emit({
			id: "2",
			timestamp: Date.now(),
			sessionId: "other-session",
			agentName: "worker",
			type: "agent:message",
			payload: { text: "world" },
		});

		expect(received.length).toBe(1);
		expect(received[0].sessionId).toBe("match-me");

		await session.close();
	});
});
