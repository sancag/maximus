import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fns for engine methods
const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockShutdown = vi.fn().mockResolvedValue(undefined);
const mockGetEventBus = vi.fn().mockReturnValue({});
const mockGetAgentRegistry = vi.fn().mockReturnValue({});
const mockGetTaskStore = vi.fn().mockReturnValue({});

const MockTraceLog = vi.fn(function (this: any) {
	this.attach = vi.fn();
	this.detach = vi.fn();
});

vi.mock("@maximus/core", () => {
	const MockEngine = vi.fn(function (this: any) {
		this.initialize = mockInitialize;
		this.shutdown = mockShutdown;
		this.getEventBus = mockGetEventBus;
		this.getAgentRegistry = mockGetAgentRegistry;
		this.getTaskStore = mockGetTaskStore;
	});
	return { AgentEngine: MockEngine, TraceLog: MockTraceLog };
});

const mockServerListen = vi.fn((_port: number, cb?: () => void) => cb?.());
const mockServerClose = vi.fn();
const mockBridgeDestroy = vi.fn();
const mockCreateApp = vi.fn().mockReturnValue({
	app: {},
	server: { listen: mockServerListen, close: mockServerClose },
	wss: {},
	bridge: { destroy: mockBridgeDestroy },
});

vi.mock("../app.js", () => ({
	createApp: mockCreateApp,
}));

const mockSchedulerStart = vi.fn();
const mockSchedulerStop = vi.fn();
const mockRegisterPipeline = vi.fn();
vi.mock("../scheduler/index.js", () => {
	const MockScheduler = vi.fn(function (this: any) {
		this.start = mockSchedulerStart;
		this.stop = mockSchedulerStop;
		this.getStore = vi.fn();
		this.registerPipeline = mockRegisterPipeline;
	});
	return { JobScheduler: MockScheduler };
});

vi.mock("../scheduler/store.js", () => {
	const MockStore = vi.fn(function (this: any) {
		// no-op constructor
	});
	return { JobStore: MockStore };
});

vi.mock("@maximus/memory", () => {
	const MockMemoryEngine = vi.fn(function (this: any) {
		this.close = vi.fn().mockResolvedValue(undefined);
	});
	const MockDeepSleepPipeline = vi.fn(function (this: any) {
		this.run = vi.fn().mockResolvedValue({});
	});
	return { MemoryEngine: MockMemoryEngine, DeepSleepPipeline: MockDeepSleepPipeline };
});

vi.mock("@maximus/shared", () => ({
	deepSleepConfigSchema: { parse: vi.fn().mockReturnValue({}) },
}));

// Suppress pino logging in tests
vi.mock("pino", () => ({
	default: () => ({
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
	}),
}));

describe("bootstrap()", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		delete process.env.PORT;
		delete process.env.AGENTS_DIR;
		delete process.env.SKILLS_DIR;
		delete process.env.MAXIMUS_VAULT_PATH;
		delete process.env.MAXIMUS_VAULT_KEY;
	});

	it("creates AgentEngine, initializes, calls createApp, and listens on default port 4100", async () => {
		const { bootstrap } = await import("../main.js");
		const { AgentEngine } = await import("@maximus/core");

		await bootstrap();

		// AgentEngine created with default config
		expect(AgentEngine).toHaveBeenCalledWith(
			expect.objectContaining({
				agentsDir: "./agents",
				skillsDir: "./skills",
			}),
		);

		// engine.initialize() called
		expect(mockInitialize).toHaveBeenCalled();

		// createApp called with engine instance and scheduler
		expect(mockCreateApp).toHaveBeenCalledWith(
			expect.objectContaining({
				initialize: mockInitialize,
			}),
			expect.anything(),
		);

		// server.listen called with default port 4100
		expect(mockServerListen).toHaveBeenCalledWith(4100, expect.any(Function));
	});

	it("uses PORT from environment when set", async () => {
		process.env.PORT = "4000";

		vi.resetModules();
		vi.doMock("@maximus/core", () => {
			const MockEngine = vi.fn(function (this: any) {
				this.initialize = mockInitialize;
				this.shutdown = mockShutdown;
				this.getEventBus = mockGetEventBus;
				this.getAgentRegistry = mockGetAgentRegistry;
				this.getTaskStore = mockGetTaskStore;
			});
			return { AgentEngine: MockEngine, TraceLog: MockTraceLog };
		});
		vi.doMock("../app.js", () => ({
			createApp: mockCreateApp,
		}));
		vi.doMock("pino", () => ({
			default: () => ({
				info: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
			}),
		}));
		vi.doMock("../scheduler/index.js", () => {
			const MockScheduler = vi.fn(function (this: any) {
				this.start = mockSchedulerStart;
				this.stop = mockSchedulerStop;
				this.getStore = vi.fn();
				this.registerPipeline = mockRegisterPipeline;
			});
			return { JobScheduler: MockScheduler };
		});
		vi.doMock("../scheduler/store.js", () => {
			const MockStore = vi.fn(function (this: any) {});
			return { JobStore: MockStore };
		});
		vi.doMock("@maximus/memory", () => {
			const MockMemoryEngine = vi.fn(function (this: any) {
				this.close = vi.fn().mockResolvedValue(undefined);
			});
			const MockDeepSleepPipeline = vi.fn(function (this: any) {
				this.run = vi.fn().mockResolvedValue({});
			});
			return { MemoryEngine: MockMemoryEngine, DeepSleepPipeline: MockDeepSleepPipeline };
		});
		vi.doMock("@maximus/shared", () => ({
			deepSleepConfigSchema: { parse: vi.fn().mockReturnValue({}) },
		}));

		const { bootstrap } = await import("../main.js");
		await bootstrap();

		expect(mockServerListen).toHaveBeenCalledWith(4000, expect.any(Function));
	});

	it("registers SIGTERM and SIGINT shutdown handlers", async () => {
		const processOnSpy = vi.spyOn(process, "on");

		vi.resetModules();
		vi.doMock("@maximus/core", () => {
			const MockEngine = vi.fn(function (this: any) {
				this.initialize = mockInitialize;
				this.shutdown = mockShutdown;
				this.getEventBus = mockGetEventBus;
				this.getAgentRegistry = mockGetAgentRegistry;
				this.getTaskStore = mockGetTaskStore;
			});
			return { AgentEngine: MockEngine, TraceLog: MockTraceLog };
		});
		vi.doMock("../app.js", () => ({
			createApp: mockCreateApp,
		}));
		vi.doMock("pino", () => ({
			default: () => ({
				info: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
			}),
		}));
		vi.doMock("../scheduler/index.js", () => {
			const MockScheduler = vi.fn(function (this: any) {
				this.start = mockSchedulerStart;
				this.stop = mockSchedulerStop;
				this.getStore = vi.fn();
				this.registerPipeline = mockRegisterPipeline;
			});
			return { JobScheduler: MockScheduler };
		});
		vi.doMock("../scheduler/store.js", () => {
			const MockStore = vi.fn(function (this: any) {});
			return { JobStore: MockStore };
		});
		vi.doMock("@maximus/memory", () => {
			const MockMemoryEngine = vi.fn(function (this: any) {
				this.close = vi.fn().mockResolvedValue(undefined);
			});
			const MockDeepSleepPipeline = vi.fn(function (this: any) {
				this.run = vi.fn().mockResolvedValue({});
			});
			return { MemoryEngine: MockMemoryEngine, DeepSleepPipeline: MockDeepSleepPipeline };
		});
		vi.doMock("@maximus/shared", () => ({
			deepSleepConfigSchema: { parse: vi.fn().mockReturnValue({}) },
		}));

		const { bootstrap } = await import("../main.js");
		await bootstrap();

		expect(processOnSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
		expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));

		processOnSpy.mockRestore();
	});
});
