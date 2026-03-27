import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock ws module before importing StatusWebSocket
const mockWsInstances: EventEmitter[] = [];
vi.mock("ws", () => {
	return {
		default: class MockWebSocket extends EventEmitter {
			constructor(_url: string) {
				super();
				mockWsInstances.push(this);
				// Simulate async open
				setTimeout(() => this.emit("open"), 0);
			}
			close() {
				this.emit("close");
			}
		},
	};
});

import { StatusWebSocket } from "../repl/ws-client.js";

describe("StatusWebSocket", () => {
	let onUpdate: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockWsInstances.length = 0;
		onUpdate = vi.fn();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("calls onUpdate with serverOnline: true on open", async () => {
		const client = new StatusWebSocket(onUpdate);
		client.connect(4100);

		// Advance timers so the setTimeout(emit('open'), 0) fires
		await vi.advanceTimersByTimeAsync(1);

		expect(onUpdate).toHaveBeenCalledWith({ serverOnline: true });
		client.destroy();
	});

	it("calls onUpdate with serverOnline: false on close", async () => {
		const client = new StatusWebSocket(onUpdate);
		client.connect(4100);
		await vi.advanceTimersByTimeAsync(1);

		onUpdate.mockClear();
		mockWsInstances[0].emit("close");

		expect(onUpdate).toHaveBeenCalledWith({
			serverOnline: false,
			activeAgent: undefined,
		});
		client.destroy();
	});

	it("parses connected frame", async () => {
		const client = new StatusWebSocket(onUpdate);
		client.connect(4100);
		await vi.advanceTimersByTimeAsync(1);

		onUpdate.mockClear();
		const frame = JSON.stringify({
			type: "connected",
			payload: { message: "Connected" },
			seq: 0,
		});
		mockWsInstances[0].emit("message", Buffer.from(frame));

		expect(onUpdate).toHaveBeenCalledWith({ serverOnline: true });
		client.destroy();
	});

	it("destroy prevents reconnection", async () => {
		const client = new StatusWebSocket(onUpdate);
		client.connect(4100);
		await vi.advanceTimersByTimeAsync(1);

		client.destroy();
		onUpdate.mockClear();

		// Advance timers well past any reconnect delay
		await vi.advanceTimersByTimeAsync(30_000);

		// Should not have created new connections
		expect(mockWsInstances.length).toBe(1);
	});

	it("handles malformed messages without throwing", async () => {
		const client = new StatusWebSocket(onUpdate);
		client.connect(4100);
		await vi.advanceTimersByTimeAsync(1);

		// Send garbage data -- should not throw
		expect(() => {
			mockWsInstances[0].emit("message", Buffer.from("not json"));
		}).not.toThrow();

		client.destroy();
	});
});
