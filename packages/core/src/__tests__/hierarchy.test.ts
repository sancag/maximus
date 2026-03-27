import { describe, it, expect, beforeEach } from "vitest";
import type { AgentDefinition } from "@maximus/shared";
import { AgentRegistry } from "../agents/registry.js";

function makeAgent(
	overrides: Partial<AgentDefinition> & { name: string },
): AgentDefinition {
	return {
		description: `${overrides.name} agent`,
		model: "sonnet",
		maxTurns: 25,
		skills: [],
		prompt: "You are a test agent.",
		filePath: `/agents/${overrides.name}.md`,
		...overrides,
	};
}

describe("AgentRegistry hierarchy", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		registry = new AgentRegistry();
		registry.register(makeAgent({ name: "orchestrator" }));
		registry.register(
			makeAgent({ name: "manager", reportsTo: "orchestrator" }),
		);
		registry.register(makeAgent({ name: "worker", reportsTo: "manager" }));
	});

	it("getReports returns agents whose reportsTo matches", () => {
		const reports = registry.getReports("orchestrator");
		expect(reports).toHaveLength(1);
		expect(reports[0].name).toBe("manager");
	});

	it("canDelegateTo returns true when target reportsTo from", () => {
		expect(registry.canDelegateTo("orchestrator", "manager")).toBe(true);
	});

	it("canDelegateTo returns false when target does not report to from", () => {
		expect(registry.canDelegateTo("worker", "orchestrator")).toBe(false);
	});

	it("canDelegateTo returns false for nonexistent agent", () => {
		expect(registry.canDelegateTo("orchestrator", "nonexistent")).toBe(
			false,
		);
	});

	it("getOrgChart returns array of all agents with name, reportsTo, description", () => {
		const chart = registry.getOrgChart();
		expect(chart).toHaveLength(3);
		const manager = chart.find((a) => a.name === "manager");
		expect(manager).toBeDefined();
		expect(manager!.reportsTo).toBe("orchestrator");
		expect(manager!.description).toBe("manager agent");
	});
});
