import { Router } from "express";
import type { TaskStore } from "@maximus/core";

export function taskRoutes(store: TaskStore): Router {
	const router = Router();

	// GET /api/tasks?traceId=...&agentName=...&status=...
	router.get("/", (req, res) => {
		const { traceId, agentName, status } = req.query;
		let tasks = store.getAll();
		if (typeof traceId === "string")
			tasks = tasks.filter((t) => t.traceId === traceId);
		if (typeof agentName === "string")
			tasks = tasks.filter((t) => t.agentName === agentName);
		if (typeof status === "string")
			tasks = tasks.filter((t) => t.status === status);
		res.json({ tasks });
	});

	// GET /api/tasks/:id
	router.get("/:id", (req, res) => {
		try {
			const task = store.get(req.params.id);
			res.json({ task });
		} catch {
			res.status(404).json({
				error: `Task not found: ${req.params.id}`,
			});
		}
	});

	return router;
}
