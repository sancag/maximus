import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AgentEvent, Task, OrgChartResponse, KnowledgeGraphResponse } from "@maximus/shared";
import type { ConnectionStatus, ViewType, ChatMessage } from "@/types";
import { api } from "@/lib/api";

interface DashboardState {
	connectionStatus: ConnectionStatus;
	events: AgentEvent[];
	agents: OrgChartResponse["agents"];
	tasks: Task[];
	activeView: ViewType;
	chatMessages: ChatMessage[];
	memoryGraph: KnowledgeGraphResponse | null;
	memoryAgents: Array<{ agentName: string; count: number }>;

	setConnectionStatus: (status: ConnectionStatus) => void;
	addEvent: (event: AgentEvent) => void;
	setAgents: (agents: OrgChartResponse["agents"]) => void;
	setTasks: (tasks: Task[]) => void;
	setActiveView: (view: ViewType) => void;
	addChatMessage: (message: ChatMessage) => void;
	updateLastChatMessage: (updater: (content: string) => string) => void;
	setLastMessageStreaming: (streaming: boolean) => void;
	clearChatMessages: () => void;
	setMemoryGraph: (data: KnowledgeGraphResponse | null) => void;
	setMemoryAgents: (agents: Array<{ agentName: string; count: number }>) => void;
	refreshTasks: () => Promise<void>;
	syncState: () => Promise<void>;
}

export const useStore = create<DashboardState>()(
	persist(
		(set) => ({
			connectionStatus: "connecting",
			events: [],
			agents: [],
			tasks: [],
			activeView: "operations",
			chatMessages: [],
			memoryGraph: null,
			memoryAgents: [],

			setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
			addEvent: (event) =>
				set((s) => {
					// Deduplicate by event id (history may overlap with live stream)
					if (s.events.some((e) => e.id === event.id)) return s;
					return { events: [event, ...s.events].slice(0, 500) };
				}),
			setAgents: (agents) => set({ agents }),
			setTasks: (tasks) => set({ tasks }),
			setActiveView: (activeView) => set({ activeView }),
			addChatMessage: (message) =>
				set((s) => ({
					chatMessages: [...s.chatMessages, message],
				})),
			updateLastChatMessage: (updater) =>
				set((s) => {
					const messages = [...s.chatMessages];
					if (messages.length > 0) {
						const last = messages[messages.length - 1];
						messages[messages.length - 1] = {
							...last,
							content: updater(last.content),
						};
					}
					return { chatMessages: messages };
				}),
			setLastMessageStreaming: (streaming) =>
				set((s) => {
					const messages = [...s.chatMessages];
					if (messages.length > 0) {
						const last = messages[messages.length - 1];
						messages[messages.length - 1] = { ...last, streaming };
					}
					return { chatMessages: messages };
				}),
			clearChatMessages: () => set({ chatMessages: [] }),
			setMemoryGraph: (memoryGraph) => set({ memoryGraph }),
			setMemoryAgents: (memoryAgents) => set({ memoryAgents }),
			refreshTasks: async () => {
				const res = await api.getTasks();
				set({ tasks: res.tasks });
			},
			syncState: async () => {
				const [orgRes, tasksRes, memoryStatusRes, memoryGraphRes, eventsRes] = await Promise.allSettled([
					api.getOrgChart(),
					api.getTasks(),
					api.getMemoryStatus(),
					api.getMemoryGraph(),
					api.getRecentEvents(200),
				]);
				set((s) => {
					// Merge historical events with any already received via WebSocket
					let events = s.events;
					if (eventsRes.status === "fulfilled") {
						const existingIds = new Set(events.map((e) => e.id));
						const newEvents = eventsRes.value.events.filter((e) => !existingIds.has(e.id));
						events = [...events, ...newEvents]
							.sort((a, b) => b.timestamp - a.timestamp)
							.slice(0, 500);
					}
					return {
						agents: orgRes.status === "fulfilled" ? orgRes.value.agents : [],
						tasks: tasksRes.status === "fulfilled" ? tasksRes.value.tasks : [],
						memoryAgents: memoryStatusRes.status === "fulfilled" ? memoryStatusRes.value.episodes.byAgent : [],
						memoryGraph: memoryGraphRes.status === "fulfilled" ? memoryGraphRes.value : null,
						events,
					};
				});
			},
		}),
		{
			name: "maximus-dashboard",
			// Only persist chat messages — everything else is loaded from API
			partialize: (state: DashboardState) => ({
				chatMessages: state.chatMessages,
			}),
		},
	),
);
