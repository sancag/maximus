import { Router } from "express";
import type { JobScheduler } from "../scheduler/index.js";

export function jobRoutes(scheduler: JobScheduler): Router {
	const router = Router();

	// GET /api/jobs — list all jobs with merged state
	router.get("/", (_req, res) => {
		const jobs = scheduler.listJobs();
		res.json({ jobs });
	});

	// POST /api/jobs — create a new job
	router.post("/", (req, res) => {
		try {
			const job = scheduler.getStore().createJob(req.body);
			scheduler.reload();
			res.status(201).json(job);
		} catch (err: any) {
			res.status(400).json({ error: err.message });
		}
	});

	// GET /api/jobs/:id — get specific job with state
	router.get("/:id", (req, res) => {
		const job = scheduler.getStore().getJob(req.params.id);
		if (!job) {
			res.status(404).json({ error: `Job not found: ${req.params.id}` });
			return;
		}
		const states = scheduler.listJobs();
		const merged = states.find((j) => j.id === req.params.id);
		res.json(merged ?? job);
	});

	// PATCH /api/jobs/:id — update a job
	router.patch("/:id", (req, res) => {
		try {
			const job = scheduler.getStore().updateJob(req.params.id, req.body);
			scheduler.reload();
			res.json(job);
		} catch (err: any) {
			res.status(404).json({ error: err.message });
		}
	});

	// DELETE /api/jobs/:id — remove a job
	router.delete("/:id", (req, res) => {
		scheduler.getStore().deleteJob(req.params.id);
		scheduler.reload();
		res.status(204).end();
	});

	// POST /api/jobs/:id/run — trigger immediate execution
	router.post("/:id/run", async (req, res) => {
		try {
			await scheduler.triggerJob(req.params.id);
			res.json({ status: "triggered" });
		} catch (err: any) {
			res.status(404).json({ error: err.message });
		}
	});

	return router;
}
