import EventEmitter from "eventemitter3";
import type { AgentEvent, AgentEventType } from "@maximus/shared";

export class EventBus {
	private emitter = new EventEmitter();

	emit(event: AgentEvent): void {
		this.emitter.emit(event.type, event);
		this.emitter.emit("*", event);
	}

	on(
		type: AgentEventType,
		handler: (event: AgentEvent) => void,
	): () => void {
		this.emitter.on(type, handler);
		return () => this.emitter.off(type, handler);
	}

	onAny(handler: (event: AgentEvent) => void): () => void {
		this.emitter.on("*", handler);
		return () => this.emitter.off("*", handler);
	}

	removeAllListeners(): void {
		this.emitter.removeAllListeners();
	}
}
