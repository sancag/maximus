import { describe, it, expect, vi } from "vitest";
import { success, info, warn, createTable, createSpinner } from "../lib/output.js";

describe("Output helpers", () => {
	it("createTable returns a table instance with headers", () => {
		const table = createTable(["Name", "Value"]);
		expect(table).toBeDefined();
		expect(typeof table.push).toBe("function");
		expect(typeof table.toString).toBe("function");
	});

	it("createSpinner returns an ora spinner", () => {
		const spinner = createSpinner("loading");
		expect(spinner).toBeDefined();
		expect(typeof spinner.start).toBe("function");
		expect(typeof spinner.stop).toBe("function");
	});

	it("success logs message with checkmark", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		success("done");
		expect(spy).toHaveBeenCalledOnce();
		const logged = spy.mock.calls[0].join(" ");
		expect(logged).toContain("done");
		spy.mockRestore();
	});

	it("info logs message", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		info("details");
		expect(spy).toHaveBeenCalledOnce();
		const logged = spy.mock.calls[0].join(" ");
		expect(logged).toContain("details");
		spy.mockRestore();
	});

	it("warn logs message", () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		warn("caution");
		expect(spy).toHaveBeenCalledOnce();
		const logged = spy.mock.calls[0].join(" ");
		expect(logged).toContain("caution");
		spy.mockRestore();
	});
});
