import express from "express";
import cors from "cors";
import path from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { AgentEngine } from "@maximus/core";
import type { MemoryEngine } from "@maximus/memory";
import { taskRoutes } from "./routes/tasks.js";
import { agentRoutes } from "./routes/agents.js";
import { healthRoutes } from "./routes/health.js";
import { chatRoutes } from "./routes/chat.js";
import { skillRoutes } from "./routes/skills.js";
import { jobRoutes } from "./routes/jobs.js";
import { memoryRoutes } from "./routes/memory.js";
import type { MemoryRoutesDeps } from "./routes/memory.js";
import { eventRoutes } from "./routes/events.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";
import type { JobScheduler } from "./scheduler/index.js";
import { EventBridge } from "./ws/bridge.js";
import { createWsHandler } from "./ws/handler.js";
import type { Server } from "node:http";

export interface AppComponents {
	app: express.Express;
	server: Server;
	wss: WebSocketServer;
	bridge: EventBridge;
}

export function createApp(engine: AgentEngine, scheduler?: JobScheduler, memoryEngine?: MemoryEngine, memoryDeps?: MemoryRoutesDeps, tracesDir?: string): AppComponents {
	const app = express();
	app.use(cors());
	app.use(express.json());

	// REST routes
	app.use("/api/tasks", taskRoutes(engine.getTaskStore()));
	app.use("/api/agents", agentRoutes(engine.getAgentRegistry()));
	app.use("/api/health", healthRoutes());
	app.use("/api/chat", chatRoutes(engine));
	app.use("/api/skills", skillRoutes(engine.getSkillRegistry()));
	if (scheduler) {
		app.use("/api/jobs", jobRoutes(scheduler));
	}
	if (memoryEngine) {
		app.use("/api/memory", memoryRoutes(memoryEngine, memoryDeps));
	}
	if (tracesDir) {
		app.use("/api/events", eventRoutes(tracesDir));
	}

	// Dashboard static assets
	const dashboardPath = process.env.DASHBOARD_PATH
		|| path.resolve(import.meta.dirname, "../../dashboard/out");
	app.use(express.static(dashboardPath));

	// SPA fallback — serves index.html for non-API GET requests
	// so client-side routing works (e.g., /org-chart refreshes correctly)
	app.get("{*path}", (req, res, next) => {
		if (req.path.startsWith("/api/")) {
			return next();
		}
		res.sendFile(path.join(dashboardPath, "index.html"));
	});

	// Error handling
	app.use(notFoundHandler);
	app.use(errorHandler);

	// HTTP server
	const server = createServer(app);

	// WebSocket
	const wss = new WebSocketServer({ noServer: true });
	const bridge = new EventBridge(engine.getEventBus(), wss);

	server.on("upgrade", (request, socket, head) => {
		if (request.url === "/ws") {
			wss.handleUpgrade(request, socket, head, (ws) => {
				wss.emit("connection", ws, request);
			});
		} else {
			socket.destroy();
		}
	});

	const wsHandler = createWsHandler(engine, Date.now());
	wss.on("connection", wsHandler);

	return { app, server, wss, bridge };
}
