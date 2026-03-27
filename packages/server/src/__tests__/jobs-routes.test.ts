import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobStore } from "../scheduler/store.js";
import { JobScheduler } from "../scheduler/index.js";
import { jobRoutes } from "../routes/jobs.js";

let server: Server;
let baseUrl: string;
let scheduler: JobScheduler;
let dir: string;

function createMockEngine() {
	const eventBus = {
		emit: vi.fn(),
		on: vi.fn(() => () => {}),
		onAny: vi.fn(() => () => {}),
		removeAllListeners: vi.fn(),
	};
	return {
		runAgent: vi.fn().mockResolvedValue({
			sessionId: "test",
			success: true,
			output: "done",
		}),
		getEventBus: vi.fn(() => eventBus),
		getAgentRegistry: vi.fn(() => ({})),
	} as any;
}

const validJobBody = {
	id: "test-job",
	name: "Test Job",
	agent: "orchestrator",
	prompt: "Do something",
	schedule: "*/5 * * * *",
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "jobs-routes-test-"));
	const store = new JobStore({
		jobsPath: join(dir, "jobs.json"),
		statePath: join(dir, "job-state.json"),
	});
	const engine = createMockEngine();
	scheduler = new JobScheduler(engine, store);

	const app = express();
	app.use(express.json());
	app.use("/api/jobs", jobRoutes(scheduler));

	server = createServer(app);
	await new Promise<void>((resolve) => {
		server.listen(0, () => resolve());
	});

	const addr = server.address();
	if (addr && typeof addr === "object") {
		baseUrl = `http://127.0.0.1:${addr.port}`;
	}
});

afterAll(async () => {
	scheduler.stop();
	await new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
	rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/jobs", () => {
	it("returns empty array when no jobs exist", async () => {
		const res = await fetch(`${baseUrl}/api/jobs`);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.jobs).toEqual([]);
	});
});

describe("POST /api/jobs", () => {
	it("creates a job and returns 201", async () => {
		const res = await fetch(`${baseUrl}/api/jobs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validJobBody),
		});
		const body = await res.json();
		expect(res.status).toBe(201);
		expect(body.id).toBe("test-job");
		expect(body.name).toBe("Test Job");
		expect(body.agent).toBe("orchestrator");
	});

	it("returns 400 with invalid body (missing agent)", async () => {
		const res = await fetch(`${baseUrl}/api/jobs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "bad-job", name: "Bad" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBeDefined();
	});
});

describe("GET /api/jobs (after create)", () => {
	it("returns array with 1 item after creating a job", async () => {
		const res = await fetch(`${baseUrl}/api/jobs`);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.jobs).toHaveLength(1);
		expect(body.jobs[0].id).toBe("test-job");
	});
});

describe("GET /api/jobs/:id", () => {
	it("returns specific job with state", async () => {
		const res = await fetch(`${baseUrl}/api/jobs/test-job`);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.id).toBe("test-job");
		expect(body.state).toBeDefined();
	});

	it("returns 404 for nonexistent ID", async () => {
		const res = await fetch(`${baseUrl}/api/jobs/nonexistent`);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toContain("not found");
	});
});

describe("PATCH /api/jobs/:id", () => {
	it("updates and returns modified job", async () => {
		const res = await fetch(`${baseUrl}/api/jobs/test-job`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Updated Job" }),
		});
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.name).toBe("Updated Job");
	});
});

describe("DELETE /api/jobs/:id", () => {
	it("returns 204 and job is gone", async () => {
		// First create a job to delete
		await fetch(`${baseUrl}/api/jobs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...validJobBody, id: "to-delete", name: "Delete Me" }),
		});

		const delRes = await fetch(`${baseUrl}/api/jobs/to-delete`, {
			method: "DELETE",
		});
		expect(delRes.status).toBe(204);

		// Verify it's gone
		const getRes = await fetch(`${baseUrl}/api/jobs/to-delete`);
		expect(getRes.status).toBe(404);
	});
});

describe("POST /api/jobs/:id/run", () => {
	it("returns 404 for nonexistent ID", async () => {
		const res = await fetch(`${baseUrl}/api/jobs/nonexistent/run`, {
			method: "POST",
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toContain("not found");
	});

	it("triggers execution and returns status", async () => {
		const res = await fetch(`${baseUrl}/api/jobs/test-job/run`, {
			method: "POST",
		});
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.status).toBe("triggered");
	});
});
