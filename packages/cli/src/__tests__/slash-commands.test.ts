import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSlashDispatcher } from "../repl/slash-commands.js";

describe("createSlashDispatcher", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("dispatch returns false for non-slash input", async () => {
		const dispatcher = createSlashDispatcher();
		const result = await dispatcher.dispatch("hello");
		expect(result).toBe(false);
	});

	it("dispatch returns true for registered command", async () => {
		const dispatcher = createSlashDispatcher();
		const handler = vi.fn();
		dispatcher.register({
			name: "test",
			description: "A test command",
			handler,
		});

		const result = await dispatcher.dispatch("/test");
		expect(result).toBe(true);
		expect(handler).toHaveBeenCalledWith("");
	});

	it("dispatch returns true for unknown command (error handled)", async () => {
		const dispatcher = createSlashDispatcher();
		vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await dispatcher.dispatch("/unknown");
		expect(result).toBe(true);
	});

	it("passes args to handler", async () => {
		const dispatcher = createSlashDispatcher();
		const handler = vi.fn();
		dispatcher.register({
			name: "foo",
			description: "Foo command",
			handler,
		});

		await dispatcher.dispatch("/foo bar baz");
		expect(handler).toHaveBeenCalledWith("bar baz");
	});

	it("getCommands returns all registered commands", () => {
		const dispatcher = createSlashDispatcher();
		dispatcher.register({
			name: "a",
			description: "A",
			handler: vi.fn(),
		});
		dispatcher.register({
			name: "b",
			description: "B",
			handler: vi.fn(),
		});
		dispatcher.register({
			name: "c",
			description: "C",
			handler: vi.fn(),
		});

		expect(dispatcher.getCommands()).toHaveLength(3);
	});
});
