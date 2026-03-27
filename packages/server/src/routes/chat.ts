import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import type { AgentEngine } from "@maximus/core";

function getProjectDir(): string {
	const agentsDir = process.env.AGENTS_DIR ?? "";
	return agentsDir ? join(agentsDir, "..") : "";
}

function getUserContext(projectDir: string): string {
	if (!projectDir) return "";
	const userPath = join(projectDir, "user.md");
	if (!existsSync(userPath)) {
		return "[ONBOARDING] No user.md found. This is a new user — follow your onboarding instructions.";
	}
	try {
		const content = readFileSync(userPath, "utf-8").trim();
		if (content) return `[User info loaded from user.md]`;
	} catch {
		// Malformed
	}
	return "";
}

function getMemoryContext(projectDir: string): string {
	if (!projectDir) return "";
	const memoryPath = join(projectDir, "memory.md");
	if (!existsSync(memoryPath)) return "";
	try {
		const content = readFileSync(memoryPath, "utf-8").trim();
		if (content) return `[Long-term memory loaded from memory.md]`;
	} catch {
		// Ignore
	}
	return "";
}

export function chatRoutes(engine: AgentEngine): Router {
	const router = Router();

	// Track active session for conversation continuity
	let activeSessionId: string | undefined;

	// POST /api/chat { message: string, newSession?: boolean }
	// Returns SSE stream of agent response chunks
	router.post("/", async (req, res) => {
		const { message, newSession } = req.body;
		if (!message || typeof message !== "string") {
			res.status(400).json({ error: "message field is required" });
			return;
		}

		// Allow clients to explicitly start a new session
		if (newSession) {
			activeSessionId = undefined;
		}

		// Set SSE headers
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.flushHeaders();

		try {
			// Find the orchestrator agent (the one with no reportsTo)
			const registry = engine.getAgentRegistry();
			const allAgents = registry.getAll();
			const orchestrator = allAgents.find((a) => !a.reportsTo);

			if (!orchestrator) {
				res.write(
					`data: ${JSON.stringify({ type: "error", content: "No orchestrator agent found" })}\n\n`,
				);
				res.end();
				return;
			}

			// Build prompt with context
			const projectDir = getProjectDir();
			const userContext = getUserContext(projectDir);
			const memoryContext = getMemoryContext(projectDir);
			const contextPrefix = [userContext, memoryContext].filter(Boolean).join("\n");
			const prompt = contextPrefix ? `${contextPrefix}\n\n${message}` : message;

			// Set up event listener before starting the agent run
			const eventBus = engine.getEventBus();
			let responseText = "";

			const unsubscribe = eventBus.on("agent:message", (event) => {
				if (event.agentName === orchestrator.name) {
					const chunk = (event.payload?.text as string) || "";
					responseText += chunk;
					res.write(
						`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`,
					);
				}
			});

			// Run agent — resume existing session or start new
			const result = await engine.runAgent({
				agentName: orchestrator.name,
				prompt,
				sessionId: activeSessionId,
			});

			unsubscribe();

			// Store session ID for continuity
			if (result.sessionId) {
				activeSessionId = result.sessionId;
			}

			// Send final message with complete response
			const finalContent = result.output || responseText;
			res.write(
				`data: ${JSON.stringify({ type: "done", content: finalContent, sessionId: result.sessionId })}\n\n`,
			);
			res.end();
		} catch (error) {
			const errMsg =
				error instanceof Error ? error.message : "Unknown error";
			res.write(
				`data: ${JSON.stringify({ type: "error", content: errMsg })}\n\n`,
			);
			res.end();
		}
	});

	// POST /api/chat/new — explicitly start a new session
	router.post("/new", (_req, res) => {
		activeSessionId = undefined;
		res.json({ status: "ok", message: "New session started" });
	});

	// GET /api/chat/stream — persistent SSE connection that streams session events
	router.get("/stream", async (req, res) => {
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.flushHeaders();

		try {
			const sessionManager = engine.getSessionManager();
			const session = await sessionManager.getOrCreateSession();

			const unsubscribe = session.onEvent((event) => {
				if (event.type === "agent:message") {
					const text = (event.payload?.text as string) || "";
					res.write(`data: ${JSON.stringify({ type: "chunk", content: text })}\n\n`);
				} else if (event.type === "agent:tool_call") {
					const toolUse = event.payload?.toolUse as Record<string, unknown>;
					res.write(`data: ${JSON.stringify({ type: "tool_call", tool: toolUse?.name, input: toolUse?.input })}\n\n`);
				} else if (event.type === "agent:error") {
					res.write(`data: ${JSON.stringify({ type: "error", content: event.payload?.error })}\n\n`);
				} else if (event.type === "agent:completion") {
					res.write(`data: ${JSON.stringify({ type: "done", sessionId: session.getSessionId() })}\n\n`);
				}
			});

			// Send initial connected event with session ID
			res.write(`data: ${JSON.stringify({ type: "connected", sessionId: session.getSessionId() })}\n\n`);

			req.on("close", () => {
				unsubscribe();
			});
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : "Unknown error";
			res.write(`data: ${JSON.stringify({ type: "error", content: errMsg })}\n\n`);
			res.end();
		}
	});

	// POST /api/chat/message — fire-and-forget message to persistent session
	router.post("/message", async (req, res) => {
		const { message } = req.body;
		if (!message || typeof message !== "string") {
			res.status(400).json({ error: "message field is required" });
			return;
		}

		try {
			const sessionManager = engine.getSessionManager();
			const session = await sessionManager.getOrCreateSession();

			// Build prompt with user/memory context (same pattern as existing POST /)
			const projectDir = getProjectDir();
			const userContext = getUserContext(projectDir);
			const memoryContext = getMemoryContext(projectDir);
			const contextPrefix = [userContext, memoryContext].filter(Boolean).join("\n");
			const prompt = contextPrefix ? `${contextPrefix}\n\n${message}` : message;

			await session.send(prompt);
			res.json({ status: "accepted", sessionId: session.getSessionId() });
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : "Unknown error";
			res.status(500).json({ error: errMsg });
		}
	});

	return router;
}
