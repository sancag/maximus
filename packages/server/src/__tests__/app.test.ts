import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// Mock pino to suppress logs
vi.mock("pino", () => ({
	default: () => ({
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
	}),
}));

describe("createApp() static serving", () => {
	let server: Server;
	let baseUrl: string;
	let tmpDir: string;

	beforeAll(async () => {
		// Create temp dir with test files
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-"));
		fs.writeFileSync(path.join(tmpDir, "index.html"), "<html>SPA</html>");
		fs.writeFileSync(path.join(tmpDir, "test.css"), "body{}");
		process.env.DASHBOARD_PATH = tmpDir;

		// Mock engine with required methods
		const mockEngine = {
			getTaskStore: () => ({ getAll: () => [], get: () => undefined }),
			getAgentRegistry: () => ({ getAll: () => [], get: () => undefined }),
			getSkillRegistry: () => new Map(),
			getEventBus: () => ({
				on: vi.fn(),
				off: vi.fn(),
				emit: vi.fn(),
				onAny: vi.fn().mockReturnValue(vi.fn()),
			}),
			runTask: vi.fn(),
		} as any;

		const { createApp } = await import("../app.js");
		const components = createApp(mockEngine);
		server = components.server;

		await new Promise<void>((resolve) => {
			server.listen(0, () => resolve());
		});
		const addr = server.address() as { port: number };
		baseUrl = `http://localhost:${addr.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(tmpDir, { recursive: true });
		delete process.env.DASHBOARD_PATH;
	});

	it("serves static files from dashboard path", async () => {
		const res = await fetch(`${baseUrl}/test.css`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("body{}");
	});

	it("serves index.html for SPA fallback on unknown routes", async () => {
		const res = await fetch(`${baseUrl}/org-chart`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("SPA");
	});

	it("serves index.html for nonexistent file paths (SPA fallback)", async () => {
		const res = await fetch(`${baseUrl}/nonexistent-file`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("SPA");
	});

	it("returns JSON 404 for GET /api/nonexistent", async () => {
		const res = await fetch(`${baseUrl}/api/nonexistent`);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body).toEqual({ error: "Not found" });
	});

	it("returns JSON 404 for POST to unknown API route", async () => {
		const res = await fetch(`${baseUrl}/api/nonexistent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body).toEqual({ error: "Not found" });
	});

	it("serves actual index.html file from static dir", async () => {
		const res = await fetch(`${baseUrl}/index.html`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toBe("<html>SPA</html>");
	});
});
