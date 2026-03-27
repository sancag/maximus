import { describe, it, expect, vi, afterEach } from "vitest";
import { errorMessage, handleCommandError } from "../lib/errors.js";

describe("Error helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("errorMessage logs error with fix suggestion", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		errorMessage("bad thing", "maximus init");
		const allOutput = spy.mock.calls.map((c) => c.join(" ")).join("\n");
		expect(allOutput).toContain("Error:");
		expect(allOutput).toContain("bad thing");
		expect(allOutput).toContain("Run:");
		expect(allOutput).toContain("maximus init");
	});

	it("errorMessage logs error without fix when not provided", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		errorMessage("bad thing");
		expect(spy).toHaveBeenCalledOnce();
		const logged = spy.mock.calls[0].join(" ");
		expect(logged).toContain("bad thing");
	});

	it("handleCommandError suggests maximus init for config errors", () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation(() => undefined as never);

		handleCommandError(new Error("Config not found"));

		const allOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
		expect(allOutput).toContain("maximus init");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("handleCommandError suggests maximus vault list for credential errors", () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		handleCommandError(new Error("Credential not found: foo"));

		const allOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
		expect(allOutput).toContain("maximus vault list");
	});

	it("handleCommandError suggests maximus server start for connection errors", () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		handleCommandError(new Error("ECONNREFUSED"));

		const allOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
		expect(allOutput).toContain("maximus server start");
	});

	it("handleCommandError handles non-Error values", () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		handleCommandError("string error");

		const allOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
		expect(allOutput).toContain("string error");
	});
});
