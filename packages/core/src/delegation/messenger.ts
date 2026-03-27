import type { AgentRegistry } from "../agents/registry.js";
import type { EventBus } from "../events/bus.js";
import { HierarchyViolationError } from "./delegator.js";
import { nanoid } from "nanoid";

export interface PeerMessage {
	id: string;
	fromAgent: string;
	toAgent: string;
	content: string;
	traceId: string;
	timestamp: number;
}

export class Messenger {
	constructor(
		private registry: AgentRegistry,
		private eventBus: EventBus,
	) {}

	send(
		fromAgent: string,
		toAgent: string,
		content: string,
		traceId: string,
	): PeerMessage {
		// Validate both agents exist and share the same parent
		const from = this.registry.get(fromAgent);
		const to = this.registry.get(toAgent);
		if (from.reportsTo !== to.reportsTo) {
			throw new HierarchyViolationError(
				`Peer messaging requires same parent: ${fromAgent} (reports to ${from.reportsTo}) vs ${toAgent} (reports to ${to.reportsTo})`,
			);
		}

		const message: PeerMessage = {
			id: nanoid(),
			fromAgent,
			toAgent,
			content,
			traceId,
			timestamp: Date.now(),
		};

		this.eventBus.emit({
			id: nanoid(),
			timestamp: Date.now(),
			sessionId: "",
			agentName: fromAgent,
			type: "agent:message",
			payload: { peerMessage: message },
			traceId,
		});

		return message;
	}
}

export { HierarchyViolationError } from "./delegator.js";
