import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { TaskStore } from "@maximus/core";
import { AgentRegistry } from "@maximus/core";
import { taskRoutes } from "../routes/tasks.js";
import { agentRoutes } from "../routes/agents.js";
import { healthRoutes } from "../routes/health.js";
import { notFoundHandler, errorHandler } from "../middleware/errors.js";
import type { AgentDefinition } from "@maximus/shared";

let server: Server;
let baseUrl: string;
let store: TaskStore;
let registry: AgentRegistry;

function makeAgent(
	name: string,
	reportsTo?: string,
): AgentDefinition {
	return {
		name,
		description: `${name} agent`,
		model: "sonnet",
		maxTurns: 25,
		skills: ["search"],
		reportsTo,
		prompt: "You are a test agent.",
		filePath: `/agents/${name}.md`,
	};
}

beforeAll(async () => {
	store = new TaskStore();
	registry = new AgentRegistry();

	// Register agents
	registry.register(makeAgent("orchestrator"));
	registry.register(makeAgent("researcher", "orchestrator"));
	registry.register(makeAgent("writer", "orchestrator"));

	// Create tasks
	store.create({
		agentName: "researcher",
		prompt: "Research topic A",
		traceId: "trace-1",
	});
	store.create({
		agentName: "writer",
		prompt: "Write article",
		traceId: "trace-1",
	});
	store.create({
		agentName: "researcher",
		prompt: "Research topic B",
		traceId: "trace-2",
	});

	const app = express();
	app.use(express.json());
	app.use("/api/tasks", taskRoutes(store));
	app.use("/api/agents", agentRoutes(registry));
	app.use("/api/health", healthRoutes());
	app.use(notFoundHandler);
	app.use(errorHandler);

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
	await new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
});

describe("GET /api/health", () => {
	it("returns status ok", async () => {
		const res = await fetch(`${baseUrl}/api/health`);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.status).toBe("ok");
		expect(body.timestamp).toBeTypeOf("number");
	});
});

describe("GET /api/tasks", () => {
	it("returns all tasks", async () => {
		const res = await fetch(`${baseUrl}/api/tasks`);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.tasks).toHaveLength(3);
	});

	it("filters by traceId", async () => {
		const res = await fetch(`${baseUrl}/api/tasks?traceId=trace-1`);
		const body = await res.json();
		expect(body.tasks).toHaveLength(2);
		expect(body.tasks.every((t: any) => t.traceId === "trace-1")).toBe(
			true,
		);
	});

	it("filters by agentName", async () => {
		const res = await fetch(
			`${baseUrl}/api/tasks?agentName=researcher`,
		);
		const body = await res.json();
		expect(body.tasks).toHaveLength(2);
		expect(
			body.tasks.every((t: any) => t.agentName === "researcher"),
		).toBe(true);
	});

	it("filters by status", async () => {
		const res = await fetch(`${baseUrl}/api/tasks?status=created`);
		const body = await res.json();
		expect(body.tasks).toHaveLength(3);
	});
});

describe("GET /api/tasks/:id", () => {
	it("returns specific task", async () => {
		const allRes = await fetch(`${baseUrl}/api/tasks`);
		const allBody = await allRes.json();
		const taskId = allBody.tasks[0].id;

		const res = await fetch(`${baseUrl}/api/tasks/${taskId}`);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.task.id).toBe(taskId);
	});

	it("returns 404 for nonexistent task", async () => {
		const res = await fetch(`${baseUrl}/api/tasks/nonexistent`);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toContain("Task not found");
	});
});

describe("GET /api/agents", () => {
	it("returns agent list", async () => {
		const res = await fetch(`${baseUrl}/api/agents`);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.agents).toHaveLength(3);
		expect(body.agents[0]).toHaveProperty("name");
		expect(body.agents[0]).toHaveProperty("description");
		expect(body.agents[0]).toHaveProperty("model");
	});
});

describe("GET /api/agents/org-chart", () => {
	it("returns org chart structure", async () => {
		const res = await fetch(`${baseUrl}/api/agents/org-chart`);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.agents).toHaveLength(3);

		const orchestrator = body.agents.find(
			(a: any) => a.name === "orchestrator",
		);
		expect(orchestrator.reportsTo).toBeUndefined();

		const researcher = body.agents.find(
			(a: any) => a.name === "researcher",
		);
		expect(researcher.reportsTo).toBe("orchestrator");
	});
});

describe("404 for unknown routes", () => {
	it("returns 404 for unknown path", async () => {
		const res = await fetch(`${baseUrl}/api/unknown`);
		expect(res.status).toBe(404);
	});
});
