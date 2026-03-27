import { Router } from "express";
import type { AgentRegistry } from "@maximus/core";

export function agentRoutes(registry: AgentRegistry): Router {
	const router = Router();

	// GET /api/agents
	router.get("/", (_req, res) => {
		registry.refresh();
		const agents = registry.getAll().map((a) => ({
			name: a.name,
			description: a.description,
			model: a.model,
			reportsTo: a.reportsTo,
			skills: a.skills,
		}));
		res.json({ agents });
	});

	// GET /api/agents/org-chart
	router.get("/org-chart", (_req, res) => {
		registry.refresh();
		const agents = registry.getOrgChart();
		res.json({ agents });
	});

	return router;
}
