import { Router } from "express";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@maximus/shared";

export function eventRoutes(tracesDir: string): Router {
	const router = Router();

	router.get("/recent", (req, res) => {
		const limit = Math.min(parseInt(String(req.query.limit ?? "200"), 10) || 200, 500);

		try {
			// List trace files sorted by mtime (most recent first)
			const files = readdirSync(tracesDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => {
					const fullPath = join(tracesDir, f);
					return { name: f, path: fullPath, mtime: statSync(fullPath).mtimeMs };
				})
				.sort((a, b) => b.mtime - a.mtime);

			const events: AgentEvent[] = [];

			for (const file of files) {
				if (events.length >= limit) break;

				try {
					const content = readFileSync(file.path, "utf-8");
					const lines = content.trim().split("\n").filter(Boolean);

					for (const line of lines) {
						try {
							const event = JSON.parse(line) as AgentEvent;
							if (event.id && event.timestamp && event.type) {
								events.push(event);
							}
						} catch {
							// Skip malformed lines
						}
					}
				} catch {
					// Skip unreadable files
				}
			}

			// Sort by timestamp descending and take the limit
			events.sort((a, b) => b.timestamp - a.timestamp);
			res.json({ events: events.slice(0, limit) });
		} catch {
			// Traces dir may not exist yet
			res.json({ events: [] });
		}
	});

	return router;
}
