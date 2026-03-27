export type AgentEventType =
	| "agent:message"
	| "agent:tool_call"
	| "agent:tool_result"
	| "agent:delegation"
	| "agent:completion"
	| "agent:error"
	| "session:start"
	| "session:end"
	| "task:created"
	| "task:assigned"
	| "task:completed"
	| "task:failed"
	| "job:started"
	| "job:completed"
	| "job:failed";

export interface AgentEvent {
	id: string;
	timestamp: number;
	sessionId: string;
	agentName: string;
	type: AgentEventType;
	payload: Record<string, unknown>;
	traceId?: string;
	parentSessionId?: string;
}
