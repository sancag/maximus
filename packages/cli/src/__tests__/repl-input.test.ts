import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Interface } from "node:readline";

// Mock readline to capture the line handler
const mockRl = Object.assign(new EventEmitter(), {
	prompt: vi.fn(),
	close: vi.fn(),
	pause: vi.fn(),
	resume: vi.fn(),
});

vi.mock("node:readline", () => ({
	createInterface: vi.fn(() => mockRl),
}));

import { startInputLoop } from "../repl/input-loop.js";
import type { SlashDispatcher } from "../repl/slash-commands.js";

function createMockDispatcher(): SlashDispatcher & {
	dispatchFn: ReturnType<typeof vi.fn>;
} {
	const dispatchFn = vi.fn().mockResolvedValue(false);
	return {
		register: vi.fn(),
		dispatch: dispatchFn,
		getCommands: vi.fn().mockReturnValue([]),
		dispatchFn,
	};
}

describe("startInputLoop", () => {
	let onChat: ReturnType<typeof vi.fn>;
	let dispatcher: ReturnType<typeof createMockDispatcher>;

	beforeEach(() => {
		vi.clearAllMocks();
		onChat = vi.fn().mockResolvedValue(undefined);
		dispatcher = createMockDispatcher();
	});

	afterEach(() => {
		mockRl.removeAllListeners();
	});

	it("routes slash commands to dispatcher", async () => {
		dispatcher.dispatchFn.mockResolvedValue(true);
		startInputLoop({ onChat, dispatcher });

		// Emit a line event with a slash command
		mockRl.emit("line", "/help");
		// Allow async handler to complete
		await new Promise((r) => setTimeout(r, 10));

		expect(dispatcher.dispatch).toHaveBeenCalledWith("/help");
		expect(onChat).not.toHaveBeenCalled();
	});

	it("routes bare text to onChat", async () => {
		dispatcher.dispatchFn.mockResolvedValue(false);
		startInputLoop({ onChat, dispatcher });

		mockRl.emit("line", "hello world");
		await new Promise((r) => setTimeout(r, 10));

		expect(onChat).toHaveBeenCalledWith("hello world");
	});

	it("empty lines re-prompt without action", async () => {
		startInputLoop({ onChat, dispatcher });

		mockRl.emit("line", "   ");
		await new Promise((r) => setTimeout(r, 10));

		expect(onChat).not.toHaveBeenCalled();
		expect(dispatcher.dispatch).not.toHaveBeenCalled();
		expect(mockRl.prompt).toHaveBeenCalled();
	});
});
