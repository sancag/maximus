import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// Mock node:http
vi.mock("node:http", () => ({
	request: vi.fn(),
}));

// Mock config
vi.mock("../lib/config.js", () => ({
	getConfig: vi.fn().mockReturnValue({ port: 4100 }),
}));

// Mock errors (prevent process.exit in tests)
vi.mock("../lib/errors.js", () => ({
	handleCommandError: vi.fn(),
}));

import { request } from "node:http";

const mockedRequest = vi.mocked(request);

interface MockReq extends EventEmitter {
	write: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
}

function createMockReq(): MockReq {
	const mockReq = new EventEmitter() as MockReq;
	mockReq.write = vi.fn();
	mockReq.end = vi.fn();
	mockReq.destroy = vi.fn();
	return mockReq;
}

function createSSEResponse(
	events: Array<{ type: string; [key: string]: unknown }>,
): Readable {
	const mockRes = new Readable({ read() {} });
	const sseData = events
		.map((e) => `data: ${JSON.stringify(e)}\n\n`)
		.join("");
	// Push data async so listeners are attached
	setTimeout(() => {
		mockRes.push(sseData);
	}, 5);
	return mockRes;
}

describe("persistent SSE client functions", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		const { getConfig } = await import("../lib/config.js");
		vi.mocked(getConfig).mockReturnValue({ port: 4100 } as any);
	});

	describe("connectPersistentStream", () => {
		it("makes GET request to /api/chat/stream", async () => {
			const mockReq = createMockReq();
			mockReq.end = vi.fn().mockImplementation(() => {
				// don't trigger response
			});
			mockedRequest.mockImplementation((_opts: any, _cb: any) => {
				return mockReq as any;
			});

			const { connectPersistentStream } = await import(
				"../commands/chat.js"
			);
			connectPersistentStream({
				onChunk: () => {},
				onDone: () => {},
				onError: () => {},
			});

			expect(mockedRequest).toHaveBeenCalledWith(
				expect.objectContaining({
					method: "GET",
					path: "/api/chat/stream",
					headers: expect.objectContaining({
						Accept: "text/event-stream",
					}),
				}),
				expect.any(Function),
			);
		});

		it("calls onChunk for chunk events", async () => {
			const mockReq = createMockReq();
			const mockRes = createSSEResponse([
				{ type: "chunk", content: "Hello" },
				{ type: "chunk", content: " world" },
			]);

			mockedRequest.mockImplementation((_opts: any, cb: any) => {
				cb(mockRes);
				return mockReq as any;
			});

			const { connectPersistentStream } = await import(
				"../commands/chat.js"
			);

			const chunks: string[] = [];
			connectPersistentStream({
				onChunk: (text) => chunks.push(text),
				onDone: () => {},
				onError: () => {},
			});

			// Wait for async SSE data
			await new Promise((r) => setTimeout(r, 20));
			expect(chunks).toEqual(["Hello", " world"]);
		});

		it("calls onConnected for connected events", async () => {
			const mockReq = createMockReq();
			const mockRes = createSSEResponse([
				{ type: "connected", sessionId: "sess-123" },
			]);

			mockedRequest.mockImplementation((_opts: any, cb: any) => {
				cb(mockRes);
				return mockReq as any;
			});

			const { connectPersistentStream } = await import(
				"../commands/chat.js"
			);

			let connectedId = "";
			connectPersistentStream({
				onConnected: (sid) => {
					connectedId = sid;
				},
				onChunk: () => {},
				onDone: () => {},
				onError: () => {},
			});

			await new Promise((r) => setTimeout(r, 20));
			expect(connectedId).toBe("sess-123");
		});

		it("calls onDone for done events", async () => {
			const mockReq = createMockReq();
			const mockRes = createSSEResponse([
				{ type: "done", sessionId: "sess-456" },
			]);

			mockedRequest.mockImplementation((_opts: any, cb: any) => {
				cb(mockRes);
				return mockReq as any;
			});

			const { connectPersistentStream } = await import(
				"../commands/chat.js"
			);

			let doneSessionId = "";
			connectPersistentStream({
				onChunk: () => {},
				onDone: (sid) => {
					doneSessionId = sid;
				},
				onError: () => {},
			});

			await new Promise((r) => setTimeout(r, 20));
			expect(doneSessionId).toBe("sess-456");
		});

		it("returns disconnect function that destroys request", async () => {
			const mockReq = createMockReq();
			mockedRequest.mockImplementation((_opts: any, _cb: any) => {
				return mockReq as any;
			});

			const { connectPersistentStream } = await import(
				"../commands/chat.js"
			);

			const disconnect = connectPersistentStream({
				onChunk: () => {},
				onDone: () => {},
				onError: () => {},
			});

			expect(typeof disconnect).toBe("function");
			disconnect();
			expect(mockReq.destroy).toHaveBeenCalled();
		});

		it("calls onError on ECONNREFUSED", async () => {
			const mockReq = createMockReq();
			mockReq.end = vi.fn().mockImplementation(() => {
				const err = new Error(
					"connect ECONNREFUSED",
				) as NodeJS.ErrnoException;
				err.code = "ECONNREFUSED";
				mockReq.emit("error", err);
			});

			mockedRequest.mockImplementation((_opts: any, _cb: any) => {
				return mockReq as any;
			});

			const { connectPersistentStream } = await import(
				"../commands/chat.js"
			);

			let errorMsg = "";
			connectPersistentStream({
				onChunk: () => {},
				onDone: () => {},
				onError: (err) => {
					errorMsg = err;
				},
			});

			expect(errorMsg).toContain("Server not running");
		});
	});

	describe("sendPersistentMessage", () => {
		it("sends POST to /api/chat/message with correct body", async () => {
			const mockReq = createMockReq();
			const mockRes = new Readable({ read() {} });

			mockedRequest.mockImplementation((_opts: any, cb: any) => {
				cb(mockRes);
				return mockReq as any;
			});

			const { sendPersistentMessage } = await import(
				"../commands/chat.js"
			);

			// Don't await — just fire
			const promise = sendPersistentMessage("Hello agent");

			// Push response data
			mockRes.push(
				JSON.stringify({ status: "accepted", sessionId: "sess-789" }),
			);
			mockRes.push(null);

			const result = await promise;

			expect(mockedRequest).toHaveBeenCalledWith(
				expect.objectContaining({
					method: "POST",
					path: "/api/chat/message",
					headers: expect.objectContaining({
						"Content-Type": "application/json",
					}),
				}),
				expect.any(Function),
			);

			expect(mockReq.write).toHaveBeenCalledWith(
				JSON.stringify({ message: "Hello agent" }),
			);
			expect(result).toEqual({
				status: "accepted",
				sessionId: "sess-789",
			});
		});

		it("rejects with ECONNREFUSED mapped error", async () => {
			const mockReq = createMockReq();
			mockReq.end = vi.fn().mockImplementation(() => {
				const err = new Error(
					"connect ECONNREFUSED",
				) as NodeJS.ErrnoException;
				err.code = "ECONNREFUSED";
				mockReq.emit("error", err);
			});

			mockedRequest.mockImplementation((_opts: any, _cb: any) => {
				return mockReq as any;
			});

			const { sendPersistentMessage } = await import(
				"../commands/chat.js"
			);

			await expect(sendPersistentMessage("test")).rejects.toThrow(
				"Server not running",
			);
		});
	});
});
