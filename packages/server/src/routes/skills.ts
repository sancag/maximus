import { Router } from "express";
import type { SkillDefinition } from "@maximus/shared";

export function skillRoutes(skills: Map<string, SkillDefinition>): Router {
	const router = Router();

	// GET /api/skills
	router.get("/", (_req, res) => {
		const list = Array.from(skills.values()).map((s) => ({
			name: s.name,
			description: s.description,
			toolCount: s.tools.length,
			credentials: s.credentials.map((c) => c.name),
		}));
		res.json({ skills: list });
	});

	return router;
}
