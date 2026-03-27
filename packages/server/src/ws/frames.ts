import type { AgentEvent } from "@maximus/shared";

export interface WebSocketFrame {
	type: "event" | "connected" | "error";
	event?: string;
	payload: Record<string, unknown>;
	seq: number;
}

let globalSeq = 0;

export function resetSeq(): void {
	globalSeq = 0;
}

export function createFrame(event: AgentEvent): WebSocketFrame {
	return {
		type: "event",
		event: event.type,
		payload: event as unknown as Record<string, unknown>,
		seq: ++globalSeq,
	};
}

export function createConnectedFrame(): WebSocketFrame {
	return {
		type: "connected",
		payload: { message: "Connected to Maximus event stream" },
		seq: 0,
	};
}

export function serializeFrame(frame: WebSocketFrame): string {
	return JSON.stringify(frame);
}
