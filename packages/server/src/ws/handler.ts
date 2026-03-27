import type { WebSocket } from "ws";
import type { AgentEngine } from "@maximus/core";
import { serializeFrame } from "./frames.js";
import pino from "pino";

const logger = pino({ name: "maximus-ws" });

export function createWsHandler(
	engine: AgentEngine,
	startedAt: number,
): (ws: WebSocket) => void {
	return (ws: WebSocket) => {
		logger.info("WebSocket client connected");

		const registry = engine.getAgentRegistry();
		const taskStore = engine.getTaskStore();
		const agentCount = registry.getAll().length;
		const activeTasks = taskStore
			.getAll()
			.filter((t) => t.status === "in-progress" || t.status === "assigned").length;
		const uptimeMs = Date.now() - startedAt;

		ws.send(
			serializeFrame({
				type: "connected",
				payload: {
					message: "Connected to Maximus event stream",
					agentCount,
					activeTasks,
					uptimeMs,
				},
				seq: 0,
			}),
		);

		ws.on("close", () => {
			logger.info("WebSocket client disconnected");
		});

		ws.on("error", (err) => {
			logger.error({ err: err.message }, "WebSocket error");
		});
	};
}
