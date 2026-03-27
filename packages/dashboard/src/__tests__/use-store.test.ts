import { describe, it, expect, beforeEach, vi } from "vitest";

// Reset store between tests
beforeEach(() => {
	vi.restoreAllMocks();
});

describe("useStore", () => {
	// Re-import to get fresh store state
	async function getStore() {
		vi.resetModules();
		const mod = await import("@/hooks/use-store");
		return mod.useStore;
	}

	it("has correct initial state", async () => {
		const useStore = await getStore();
		const state = useStore.getState();
		expect(state.connectionStatus).toBe("connecting");
		expect(state.events).toEqual([]);
		expect(state.agents).toEqual([]);
		expect(state.tasks).toEqual([]);
		expect(state.activeView).toBe("operations");
		expect(state.chatMessages).toEqual([]);
	});

	it("setConnectionStatus updates connectionStatus", async () => {
		const useStore = await getStore();
		useStore.getState().setConnectionStatus("connected");
		expect(useStore.getState().connectionStatus).toBe("connected");
	});

	it("addEvent prepends event to events array", async () => {
		const useStore = await getStore();
		const event1 = {
			id: "e1",
			timestamp: 1000,
			sessionId: "s1",
			agentName: "agent-a",
			type: "agent:message" as const,
			payload: {},
		};
		const event2 = {
			id: "e2",
			timestamp: 2000,
			sessionId: "s1",
			agentName: "agent-a",
			type: "agent:tool_call" as const,
			payload: {},
		};
		useStore.getState().addEvent(event1);
		useStore.getState().addEvent(event2);
		const events = useStore.getState().events;
		expect(events[0].id).toBe("e2");
		expect(events[1].id).toBe("e1");
	});

	it("addEvent caps events at 500 items", async () => {
		const useStore = await getStore();
		for (let i = 0; i < 501; i++) {
			useStore.getState().addEvent({
				id: `e${i}`,
				timestamp: i,
				sessionId: "s1",
				agentName: "agent-a",
				type: "agent:message" as const,
				payload: {},
			});
		}
		const events = useStore.getState().events;
		expect(events.length).toBe(500);
		// Newest first
		expect(events[0].id).toBe("e500");
	});

	it("setActiveView updates activeView", async () => {
		const useStore = await getStore();
		useStore.getState().setActiveView("chat");
		expect(useStore.getState().activeView).toBe("chat");
	});

	it("setAgents updates agents array", async () => {
		const useStore = await getStore();
		const agents = [{ name: "orchestrator", description: "Main agent" }];
		useStore.getState().setAgents(agents);
		expect(useStore.getState().agents).toEqual(agents);
	});

	it("setTasks updates tasks array", async () => {
		const useStore = await getStore();
		const tasks = [
			{
				id: "t1",
				agentName: "agent-a",
				status: "in-progress" as const,
				prompt: "do something",
				traceId: "tr1",
				tokenUsage: 0,
				createdAt: 1000,
				updatedAt: 1000,
			},
		];
		useStore.getState().setTasks(tasks);
		expect(useStore.getState().tasks).toEqual(tasks);
	});

	it("syncState fetches from API and populates agents + tasks", async () => {
		const mockAgents = [
			{ name: "orchestrator", description: "Main" },
			{ name: "coder", description: "Codes" },
		];
		const mockTasks = [
			{
				id: "t1",
				agentName: "coder",
				status: "completed",
				prompt: "write code",
				traceId: "tr1",
				tokenUsage: 100,
				createdAt: 1000,
				updatedAt: 2000,
			},
		];

		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.includes("/api/agents/org-chart")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ agents: mockAgents }),
					});
				}
				if (url.includes("/api/tasks")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ tasks: mockTasks }),
					});
				}
				return Promise.reject(new Error(`Unexpected fetch: ${url}`));
			}),
		);

		const useStore = await getStore();
		await useStore.getState().syncState();
		expect(useStore.getState().agents).toEqual(mockAgents);
		expect(useStore.getState().tasks).toEqual(mockTasks);
	});
});
