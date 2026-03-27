export type ViewType = "operations" | "org-chart" | "chat" | "tasks" | "knowledge-graph" | "agent-memory" | "jobs";
export type ConnectionStatus =
	| "connecting"
	| "connected"
	| "reconnecting"
	| "disconnected";

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	streaming?: boolean;
}
