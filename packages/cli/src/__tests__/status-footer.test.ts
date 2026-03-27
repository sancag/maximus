import { describe, it, expect } from "vitest";
import stripAnsi from "strip-ansi";
import { formatStatusLine, type StatusState } from "../repl/status-footer.js";

function plain(s: string): string {
	return stripAnsi(s);
}

function makeState(overrides: Partial<StatusState> = {}): StatusState {
	return {
		serverOnline: false,
		agentCount: 0,
		taskCount: 0,
		uptime: "0s",
		projectInitialized: true,
		...overrides,
	};
}

describe("formatStatusLine", () => {
	it("shows no-project state", () => {
		const out = plain(formatStatusLine(makeState({ projectInitialized: false })));
		expect(out).toContain("no agents");
		expect(out).toContain("/init");
	});

	it("shows server offline state", () => {
		const out = plain(formatStatusLine(makeState({ serverOnline: false })));
		expect(out).toContain("server offline");
		expect(out).toContain("/start");
	});

	it("shows server online with counts", () => {
		const out = plain(
			formatStatusLine(
				makeState({
					serverOnline: true,
					agentCount: 3,
					taskCount: 0,
					uptime: "2h 14m",
				}),
			),
		);
		expect(out).toContain("server online");
		expect(out).toContain("3");
		expect(out).toContain("agents");
		expect(out).toContain("2h 14m");
	});

	it("shows active agent when present", () => {
		const out = plain(
			formatStatusLine(
				makeState({
					serverOnline: true,
					activeAgent: "researcher (searching...)",
				}),
			),
		);
		expect(out).toContain("researcher (searching...)");
	});

	it("omits task count when zero", () => {
		const out = plain(
			formatStatusLine(
				makeState({
					serverOnline: true,
					taskCount: 0,
				}),
			),
		);
		expect(out).not.toContain("tasks");
	});
});
