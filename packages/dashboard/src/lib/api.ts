import type { AgentEvent, OrgChartResponse, Task } from "@maximus/shared";
import type { MemoryStatusResponse, KnowledgeGraphResponse, AgentMemoryResponse } from "@maximus/shared";

async function fetchJSON<T>(path: string): Promise<T> {
	const res = await fetch(path);
	if (!res.ok) throw new Error(`API error: ${res.status}`);
	return res.json();
}

export const api = {
	getOrgChart: () =>
		fetchJSON<OrgChartResponse>("/api/agents/org-chart"),
	getAgents: () =>
		fetchJSON<{
			agents: Array<{
				name: string;
				description: string;
				model: string;
				reportsTo?: string;
				skills: string[];
			}>;
		}>("/api/agents"),
	getTasks: (query?: Record<string, string>) => {
		const params = query ? `?${new URLSearchParams(query).toString()}` : "";
		return fetchJSON<{ tasks: Task[] }>(`/api/tasks${params}`);
	},
	getHealth: () => fetchJSON<{ status: string }>("/api/health"),
	sendMessage: (message: string) =>
		fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message }),
		}),
	getMemoryStatus: () =>
		fetchJSON<MemoryStatusResponse>("/api/memory/status"),
	getMemoryGraph: (scope?: string) =>
		fetchJSON<KnowledgeGraphResponse>(`/api/memory/graph${scope && scope !== "all" ? `?scope=${scope}` : ""}`),
	getAgentMemory: (agent: string) =>
		fetchJSON<AgentMemoryResponse>(`/api/memory/inspect/${encodeURIComponent(agent)}`),
	getRecentEvents: (limit = 200) =>
		fetchJSON<{ events: AgentEvent[] }>(`/api/events/recent?limit=${limit}`),
	getJobs: () => fetchJSON<{ jobs: unknown[] }>("/api/jobs"),
	createJob: (data: Record<string, unknown>) =>
		fetch("/api/jobs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		}),
	updateJob: (id: string, data: Record<string, unknown>) =>
		fetch(`/api/jobs/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		}),
	deleteJob: (id: string) =>
		fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
	triggerJob: (id: string) =>
		fetch(`/api/jobs/${encodeURIComponent(id)}/run`, { method: "POST" }),
};
