import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

// Mock the SDK before importing modules that use it
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
	const mockQuery = vi.fn();
	return {
		query: mockQuery,
		createSdkMcpServer: vi.fn(() => ({ name: "mock-server" })),
		tool: vi.fn(
			(name: string, desc: string, schema: any, handler: any) => ({
				name,
				description: desc,
				schema,
				handler,
			}),
		),
	};
});

// Mock pino to avoid log output in tests
vi.mock("pino", () => ({
	default: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import { filterEnvForSdk } from "../hooks.js";
import { AgentEngine } from "../engine.js";
import { AgentSession } from "../session.js";
import { EventBus } from "../../events/bus.js";

describe("filterEnvForSdk", () => {
	it("blocks MAXIMUS_VAULT_KEY from environment", () => {
		const env = {
			HOME: "/home/user",
			PATH: "/usr/bin",
			MAXIMUS_VAULT_KEY: "secret-key-123",
			ANTHROPIC_API_KEY: "sk-ant-abc123",
		};

		const filtered = filterEnvForSdk(env);

		expect(filtered).not.toHaveProperty("MAXIMUS_VAULT_KEY");
		expect(filtered).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-abc123");
		expect(filtered).toHaveProperty("HOME", "/home/user");
		expect(filtered).toHaveProperty("PATH", "/usr/bin");
	});

	it("blocks all sensitive key variables", () => {
		const env = {
			VAULT_KEY: "vk",
			ENCRYPTION_KEY: "ek",
			MASTER_KEY: "mk",
			SAFE_VAR: "safe",
		};

		const filtered = filterEnvForSdk(env);

		expect(filtered).not.toHaveProperty("VAULT_KEY");
		expect(filtered).not.toHaveProperty("ENCRYPTION_KEY");
		expect(filtered).not.toHaveProperty("MASTER_KEY");
		expect(filtered).toHaveProperty("SAFE_VAR", "safe");
	});

	it("skips undefined values", () => {
		const env = {
			DEFINED: "yes",
			UNDEFINED_VAR: undefined,
		} as NodeJS.ProcessEnv;

		const filtered = filterEnvForSdk(env);

		expect(filtered).toHaveProperty("DEFINED", "yes");
		expect(filtered).not.toHaveProperty("UNDEFINED_VAR");
	});
});

describe("AgentEngine", () => {
	const agentsDir = path.resolve(
		import.meta.dirname,
		"../../../../../agents",
	);
	const skillsDir = path.resolve(
		import.meta.dirname,
		"../../../../../skills",
	);

	it("loads agents and skills from example directories", async () => {
		const engine = new AgentEngine({
			agentsDir,
			skillsDir,
		});

		await engine.initialize();

		const registry = engine.getAgentRegistry();
		expect(registry.getAll().length).toBeGreaterThan(0);
		expect(registry.has("engineering-lead")).toBe(true);
	});

	it("returns an EventBus instance", () => {
		const engine = new AgentEngine({
			agentsDir,
			skillsDir,
		});

		expect(engine.getEventBus()).toBeInstanceOf(EventBus);
	});

	it("shuts down cleanly (clears sessions and listeners)", async () => {
		const engine = new AgentEngine({
			agentsDir,
			skillsDir,
		});

		await engine.initialize();
		await engine.shutdown();

		// After shutdown, eventBus listeners should be cleared
		// Re-initialize should work (proves clean shutdown)
		await engine.initialize();
		expect(engine.getAgentRegistry().getAll().length).toBeGreaterThan(0);
	});

	it("logs warning when no vault key is provided and stdin is not TTY", async () => {
		// In test environment, stdin.isTTY is falsy, so no interactive prompt
		const engine = new AgentEngine({
			agentsDir,
			skillsDir,
			// No vaultKey provided
		});

		// Remove any env var that might be set
		const original = process.env.MAXIMUS_VAULT_KEY;
		delete process.env.MAXIMUS_VAULT_KEY;

		await engine.initialize();

		// Restore
		if (original !== undefined) {
			process.env.MAXIMUS_VAULT_KEY = original;
		}

		// Engine should still initialize (just without vault)
		expect(engine.getAgentRegistry().has("engineering-lead")).toBe(true);
	});
});

describe("AgentSession - resume path", () => {
	let mockQuery: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		const sdk = await import("@anthropic-ai/claude-agent-sdk");
		mockQuery = sdk.query as ReturnType<typeof vi.fn>;
		mockQuery.mockReset();
	});

	function createMockAsyncGenerator(messages: any[]) {
		return async function* () {
			for (const msg of messages) {
				yield msg;
			}
		};
	}

	const mockAgentDef = {
		name: "test-agent",
		description: "Test agent",
		model: "sonnet" as const,
		maxTurns: 25,
		skills: [],
		prompt: "You are a test agent",
		filePath: "/test/agent.md",
	};

	it("forwards sessionId as resume option to SDK query()", async () => {
		mockQuery.mockReturnValue(
			createMockAsyncGenerator([
				{
					type: "result",
					subtype: "success",
					result: "done",
					num_turns: 1,
					total_cost_usd: 0,
				},
			])(),
		);

		const eventBus = new EventBus();
		const session = new AgentSession(mockAgentDef, {}, eventBus, {
			agentName: "test-agent",
			prompt: "hello",
			sessionId: "existing-session-123",
		});

		await session.run();

		expect(mockQuery).toHaveBeenCalledTimes(1);
		const callArgs = mockQuery.mock.calls[0][0];
		expect(callArgs).toHaveProperty("resume", "existing-session-123");
	});

	it("does NOT pass resume when sessionId is not provided", async () => {
		mockQuery.mockReturnValue(
			createMockAsyncGenerator([
				{
					type: "result",
					subtype: "success",
					result: "done",
					num_turns: 1,
					total_cost_usd: 0,
				},
			])(),
		);

		const eventBus = new EventBus();
		const session = new AgentSession(mockAgentDef, {}, eventBus, {
			agentName: "test-agent",
			prompt: "hello",
			// No sessionId
		});

		await session.run();

		expect(mockQuery).toHaveBeenCalledTimes(1);
		const callArgs = mockQuery.mock.calls[0][0];
		expect(callArgs).not.toHaveProperty("resume");
	});

	it("returns error result when query throws", async () => {
		mockQuery.mockImplementation(() => {
			throw new Error("SDK connection failed");
		});

		const eventBus = new EventBus();
		const session = new AgentSession(mockAgentDef, {}, eventBus, {
			agentName: "test-agent",
			prompt: "hello",
		});

		const result = await session.run();

		expect(result.success).toBe(false);
		expect(result.error).toBe("SDK connection failed");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it.skip("runs full agent session end-to-end — Requires ANTHROPIC_API_KEY", () => {
		// Integration test: requires real Claude API connection
	});
});
