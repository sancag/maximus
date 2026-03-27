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

function createMockResponse(
	events: Array<{ type: string; content: string }>,
): { mockReq: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; mockRes: Readable } {
	const mockRes = new Readable({ read() {} });
	const mockReq = new EventEmitter() as EventEmitter & {
		write: ReturnType<typeof vi.fn>;
		end: ReturnType<typeof vi.fn>;
	};
	mockReq.write = vi.fn();
	mockReq.end = vi.fn().mockImplementation(() => {
		// Simulate SSE data
		const sseData = events
			.map((e) => `data: ${JSON.stringify(e)}\n\n`)
			.join("");
		mockRes.push(sseData);
		mockRes.push(null); // end stream
	});
	return { mockReq, mockRes };
}

describe("chat command", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		// Re-apply config mock after restoreAllMocks
		const { getConfig } = await import("../lib/config.js");
		vi.mocked(getConfig).mockReturnValue({ port: 4100 } as any);
	});

	it("one-shot streams SSE chunks to stdout", async () => {
		const { mockReq, mockRes } = createMockResponse([
			{ type: "chunk", content: "Hello" },
			{ type: "chunk", content: " world" },
			{ type: "done", content: "Hello world" },
		]);

		mockedRequest.mockImplementation((_opts: any, cb: any) => {
			cb(mockRes);
			return mockReq as any;
		});

		const { streamChat } = await import("../commands/chat.js");

		const chunks: string[] = [];
		let doneContent = "";

		await streamChat(
			"test",
			(chunk) => chunks.push(chunk),
			(full) => {
				doneContent = full;
			},
			() => {},
		);

		expect(chunks).toEqual(["Hello", " world"]);
		expect(doneContent).toBe("Hello world");
	});

	it("one-shot handles error event", async () => {
		const { mockReq, mockRes } = createMockResponse([
			{ type: "error", content: "No orchestrator found" },
		]);

		mockedRequest.mockImplementation((_opts: any, cb: any) => {
			cb(mockRes);
			return mockReq as any;
		});

		const { streamChat } = await import("../commands/chat.js");

		let errorContent = "";

		await streamChat(
			"test",
			() => {},
			() => {},
			(err) => {
				errorContent = err;
			},
		);

		expect(errorContent).toBe("No orchestrator found");
	});

	it("ECONNREFUSED produces actionable error", async () => {
		const mockReq = new EventEmitter() as EventEmitter & {
			write: ReturnType<typeof vi.fn>;
			end: ReturnType<typeof vi.fn>;
		};
		mockReq.write = vi.fn();
		mockReq.end = vi.fn().mockImplementation(() => {
			const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
			err.code = "ECONNREFUSED";
			mockReq.emit("error", err);
		});

		mockedRequest.mockImplementation((_opts: any, _cb: any) => {
			return mockReq as any;
		});

		const { streamChat } = await import("../commands/chat.js");

		await expect(
			streamChat(
				"test",
				() => {},
				() => {},
				() => {},
			),
		).rejects.toThrow("Server not running");
	});

	it("registerChatCommand adds chat command to program", async () => {
		const { Command } = await import("commander");
		const { registerChatCommand } = await import("../commands/chat.js");

		const program = new Command();
		registerChatCommand(program);

		const chatCmd = program.commands.find((c) => c.name() === "chat");
		expect(chatCmd).toBeDefined();
	});

	it("chat command accepts optional message argument", async () => {
		const { Command } = await import("commander");
		const { registerChatCommand } = await import("../commands/chat.js");

		const program = new Command();
		registerChatCommand(program);

		const chatCmd = program.commands.find((c) => c.name() === "chat");
		expect(chatCmd).toBeDefined();

		// Commander stores args as registeredArguments
		const args = chatCmd!.registeredArguments;
		expect(args).toHaveLength(1);
		expect(args[0].name()).toBe("message");
		expect(args[0].required).toBe(false);
	});
});
