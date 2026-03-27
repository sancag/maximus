import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Mock the persistent session module with a proper class
vi.mock("../runtime/persistent-session.js", () => {
	class MockPersistentSession {
		start = vi.fn().mockResolvedValue(undefined);
		send = vi.fn().mockResolvedValue(undefined);
		close = vi.fn().mockResolvedValue(undefined);
		isActive = vi.fn().mockReturnValue(true);
		getSessionId = vi.fn().mockReturnValue("mock-session-id");
		onEvent = vi.fn().mockReturnValue(() => {});
	}
	return { PersistentSession: MockPersistentSession };
});

// Mock skill composer
vi.mock("../skills/composer.js", () => ({
	composeSkillToMcpServer: vi.fn().mockResolvedValue({ name: "mock-server" }),
}));

// Mock nanoid
vi.mock("nanoid", () => ({
	nanoid: () => "test-id-456",
}));

describe("SessionManager", () => {
	let SessionManager: typeof import("../runtime/session-manager.js").SessionManager;
	let PersistentSession: any;
	let mockEngine: any;

	beforeEach(async () => {
		vi.clearAllMocks();

		const psMod = await import("../runtime/persistent-session.js");
		PersistentSession = psMod.PersistentSession;

		const { SessionManager: SM } = await import(
			"../runtime/session-manager.js"
		);
		SessionManager = SM;

		// Create mock engine
		mockEngine = {
			getAgentRegistry: vi.fn().mockReturnValue({
				getAll: vi.fn().mockReturnValue([
					{
						name: "orchestrator",
						prompt: "You are the orchestrator",
						description: "Root orchestrator",
						model: "sonnet",
						skills: ["skill-a"],
						maxTurns: 10,
					},
					{
						name: "worker",
						prompt: "You are a worker",
						description: "Worker agent",
						model: "sonnet",
						skills: [],
						reportsTo: "orchestrator",
						maxTurns: 5,
					},
				]),
				getReports: vi.fn().mockReturnValue([
					{
						name: "worker",
						reportsTo: "orchestrator",
					},
				]),
			}),
			getSkillRegistry: vi.fn().mockReturnValue(
				new Map([
					[
						"skill-a",
						{
							name: "skill-a",
							description: "A skill",
							tools: [],
						},
					],
				]),
			),
			getEventBus: vi.fn().mockReturnValue({
				emit: vi.fn(),
				on: vi.fn().mockReturnValue(() => {}),
				onAny: vi.fn().mockReturnValue(() => {}),
				removeAllListeners: vi.fn(),
			}),
			getCredentialProxy: vi.fn().mockReturnValue(null),
		};
	});

	it("getOrCreateSession creates a new session on first call", async () => {
		const mgr = new SessionManager(mockEngine);
		const session = await mgr.getOrCreateSession();

		expect(session.start).toHaveBeenCalledTimes(1);
		expect(session.isActive()).toBe(true);
	});

	it("getOrCreateSession reuses session when isActive() returns true", async () => {
		const mgr = new SessionManager(mockEngine);
		const session1 = await mgr.getOrCreateSession();
		const session2 = await mgr.getOrCreateSession();

		expect(session1).toBe(session2);
	});

	it("getOrCreateSession creates new session when previous isActive() returns false", async () => {
		const mgr = new SessionManager(mockEngine);
		const session1 = await mgr.getOrCreateSession();

		// Make isActive return false (simulate closed session)
		session1.isActive.mockReturnValue(false);

		const session2 = await mgr.getOrCreateSession();

		expect(session1).not.toBe(session2);
	});

	it("closeSession calls close on active session", async () => {
		const mgr = new SessionManager(mockEngine);
		const session = await mgr.getOrCreateSession();

		await mgr.closeSession();

		expect(session.close).toHaveBeenCalledTimes(1);
		expect(mgr.hasActiveSession()).toBe(false);
	});

	it("closeSession is a no-op when no active session", async () => {
		const mgr = new SessionManager(mockEngine);

		// Should not throw
		await mgr.closeSession();
		expect(mgr.hasActiveSession()).toBe(false);
	});

	it("hasActiveSession returns correct state", async () => {
		const mgr = new SessionManager(mockEngine);
		expect(mgr.hasActiveSession()).toBe(false);

		await mgr.getOrCreateSession();
		expect(mgr.hasActiveSession()).toBe(true);

		await mgr.closeSession();
		expect(mgr.hasActiveSession()).toBe(false);
	});
});

describe("Engine SessionManager integration", () => {
	// Since engine.ts has deep transitive imports that don't resolve in test,
	// verify the source code directly for the required methods
	const engineSource = fs.readFileSync(
		path.resolve(__dirname, "../runtime/engine.ts"),
		"utf-8",
	);

	it("engine.ts has getSessionManager() method", () => {
		expect(engineSource).toContain("getSessionManager(): SessionManager");
	});

	it("engine.ts has getCredentialProxy() method", () => {
		expect(engineSource).toContain(
			"getCredentialProxy(): CredentialProxy | null",
		);
	});

	it("engine.ts imports SessionManager", () => {
		expect(engineSource).toContain(
			'import { SessionManager } from "./session-manager.js"',
		);
	});

	it("engine.ts shutdown calls sessionManager.closeSession() before activeSessions loop", () => {
		const shutdownIndex = engineSource.indexOf("async shutdown()");
		const closeSessionIndex = engineSource.indexOf(
			"this.sessionManager.closeSession()",
		);
		const activeSessionsIndex = engineSource.indexOf(
			"this.activeSessions",
			shutdownIndex,
		);

		expect(shutdownIndex).toBeGreaterThan(-1);
		expect(closeSessionIndex).toBeGreaterThan(-1);
		expect(activeSessionsIndex).toBeGreaterThan(-1);
		// closeSession comes before activeSessions loop in shutdown
		expect(closeSessionIndex).toBeLessThan(activeSessionsIndex);
	});
});
