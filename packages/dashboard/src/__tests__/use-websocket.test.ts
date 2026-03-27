import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock WebSocket
class MockWebSocket {
	static instances: MockWebSocket[] = [];
	url: string;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	readyState = 0;
	closed = false;

	constructor(url: string) {
		this.url = url;
		MockWebSocket.instances.push(this);
	}

	close() {
		this.closed = true;
		this.readyState = 3;
	}

	simulateOpen() {
		this.readyState = 1;
		this.onopen?.();
	}

	simulateMessage(data: unknown) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}

	simulateClose() {
		this.readyState = 3;
		this.onclose?.();
	}
}

describe("useWebSocket", () => {
	let mockSetConnectionStatus: ReturnType<typeof vi.fn>;
	let mockAddEvent: ReturnType<typeof vi.fn>;
	let mockSyncState: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		MockWebSocket.instances = [];
		vi.stubGlobal("WebSocket", MockWebSocket);

		mockSetConnectionStatus = vi.fn();
		mockAddEvent = vi.fn();
		mockSyncState = vi.fn();

		// Mock the store
		vi.doMock("@/hooks/use-store", () => ({
			useStore: Object.assign(
				() => ({
					setConnectionStatus: mockSetConnectionStatus,
					addEvent: mockAddEvent,
					syncState: mockSyncState,
				}),
				{
					getState: () => ({
						setConnectionStatus: mockSetConnectionStatus,
						addEvent: mockAddEvent,
						syncState: mockSyncState,
					}),
				},
			),
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.resetModules();
	});

	async function getConnect() {
		const mod = await import("@/hooks/use-websocket");
		return mod._connect;
	}

	it("creates WebSocket connection to provided URL", async () => {
		const connect = await getConnect();
		connect("ws://test:3000/ws");
		expect(MockWebSocket.instances.length).toBe(1);
		expect(MockWebSocket.instances[0].url).toBe("ws://test:3000/ws");
	});

	it("on open, sets connectionStatus to connected and calls syncState", async () => {
		const connect = await getConnect();
		connect("ws://test:3000/ws");
		const ws = MockWebSocket.instances[0];
		ws.simulateOpen();
		expect(mockSetConnectionStatus).toHaveBeenCalledWith("connected");
		expect(mockSyncState).toHaveBeenCalled();
	});

	it("on message with event frame, calls addEvent with payload", async () => {
		const connect = await getConnect();
		connect("ws://test:3000/ws");
		const ws = MockWebSocket.instances[0];
		ws.simulateOpen();

		const eventPayload = {
			id: "e1",
			timestamp: 1000,
			sessionId: "s1",
			agentName: "agent-a",
			type: "agent:message",
			payload: { content: "hello" },
		};
		ws.simulateMessage({ type: "event", payload: eventPayload, seq: 1 });
		expect(mockAddEvent).toHaveBeenCalledWith(eventPayload);
	});

	it("on close, sets connectionStatus to reconnecting and schedules reconnect", async () => {
		const connect = await getConnect();
		const cleanup = connect("ws://test:3000/ws");
		const ws = MockWebSocket.instances[0];
		ws.simulateOpen();
		ws.simulateClose();

		expect(mockSetConnectionStatus).toHaveBeenCalledWith("reconnecting");
		expect(MockWebSocket.instances.length).toBe(1);

		// Advance past initial delay (1000ms)
		vi.advanceTimersByTime(1000);
		expect(MockWebSocket.instances.length).toBe(2);

		cleanup();
	});

	it("reconnect delay doubles each attempt up to max 30000", async () => {
		const connect = await getConnect();
		const cleanup = connect("ws://test:3000/ws");

		// First close -> 1000ms delay
		MockWebSocket.instances[0].simulateClose();
		vi.advanceTimersByTime(999);
		expect(MockWebSocket.instances.length).toBe(1);
		vi.advanceTimersByTime(1);
		expect(MockWebSocket.instances.length).toBe(2);

		// Second close -> 2000ms delay
		MockWebSocket.instances[1].simulateClose();
		vi.advanceTimersByTime(1999);
		expect(MockWebSocket.instances.length).toBe(2);
		vi.advanceTimersByTime(1);
		expect(MockWebSocket.instances.length).toBe(3);

		// Third close -> 4000ms delay
		MockWebSocket.instances[2].simulateClose();
		vi.advanceTimersByTime(3999);
		expect(MockWebSocket.instances.length).toBe(3);
		vi.advanceTimersByTime(1);
		expect(MockWebSocket.instances.length).toBe(4);

		cleanup();
	});

	it("on successful reconnect, retries counter resets to 0", async () => {
		const connect = await getConnect();
		const cleanup = connect("ws://test:3000/ws");

		// First close -> reconnect at 1000ms
		MockWebSocket.instances[0].simulateClose();
		vi.advanceTimersByTime(1000);
		expect(MockWebSocket.instances.length).toBe(2);

		// Successful reconnect
		MockWebSocket.instances[1].simulateOpen();

		// Close again -> should be 1000ms delay (reset), not 2000ms
		MockWebSocket.instances[1].simulateClose();
		vi.advanceTimersByTime(999);
		expect(MockWebSocket.instances.length).toBe(2);
		vi.advanceTimersByTime(1);
		expect(MockWebSocket.instances.length).toBe(3);

		cleanup();
	});
});
