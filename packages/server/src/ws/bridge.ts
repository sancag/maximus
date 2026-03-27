import type { EventBus } from "@maximus/core";
import type { WebSocketServer, WebSocket } from "ws";
import { createFrame, serializeFrame } from "./frames.js";
import type { AgentEvent } from "@maximus/shared";
import pino from "pino";

const logger = pino({ name: "maximus-ws-bridge" });

const BACKPRESSURE_THRESHOLD = 1024 * 64; // 64KB

export class EventBridge {
	private unsubscribe: () => void;

	constructor(
		private eventBus: EventBus,
		private wss: WebSocketServer,
	) {
		this.unsubscribe = this.eventBus.onAny((event: AgentEvent) =>
			this.broadcast(event),
		);
	}

	private broadcast(event: AgentEvent): void {
		const frame = serializeFrame(createFrame(event));

		for (const client of this.wss.clients) {
			const ws = client as WebSocket;
			if (ws.readyState === 1 /* WebSocket.OPEN */) {
				// Check backpressure
				if (ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
					logger.warn(
						{ bufferedAmount: ws.bufferedAmount },
						"Skipping frame due to backpressure",
					);
					continue;
				}
				ws.send(frame);
			}
		}
	}

	destroy(): void {
		this.unsubscribe();
	}
}
