import { join } from "node:path";
import { AgentEngine, TraceLog } from "@maximus/core";
import { MemoryEngine, DeepSleepPipeline } from "@maximus/memory";
import { deepSleepConfigSchema } from "@maximus/shared";
import { createApp } from "./app.js";
import { JobScheduler } from "./scheduler/index.js";
import { JobStore } from "./scheduler/store.js";
import pino from "pino";

const logFile = process.env.MAXIMUS_LOG_FILE;
const logger = pino(
	{ name: "maximus-server" },
	logFile ? pino.destination(logFile) : undefined,
);

export async function bootstrap() {
	const port = parseInt(process.env.PORT ?? "4100", 10);
	const agentsDir = process.env.AGENTS_DIR ?? "./agents";
	const skillsDir = process.env.SKILLS_DIR ?? "./skills";
	const vaultPath = process.env.MAXIMUS_VAULT_PATH;
	const vaultKey = process.env.MAXIMUS_VAULT_KEY;

	const projectDir = process.env.AGENTS_DIR ? join(process.env.AGENTS_DIR, "..") : process.cwd();
	const memoryDir = process.env.MAXIMUS_MEMORY_DIR ?? join(projectDir, "memory");

	const tasksPath = process.env.MAXIMUS_TASKS_PATH ?? join(projectDir, "tasks.json");
	const engine = new AgentEngine({ agentsDir, skillsDir, vaultPath, vaultKey, memoryDir, tasksPath });
	await engine.initialize();
	const jobStore = new JobStore({
		jobsPath: join(projectDir, "jobs.json"),
		statePath: join(projectDir, "job-state.json"),
	});
	const scheduler = new JobScheduler(engine, jobStore);

	// Persist full event traces to disk as JSONL (one file per traceId)
	const tracesDir = process.env.MAXIMUS_TRACES_DIR ?? join(projectDir, "traces");
	const traceLog = new TraceLog(tracesDir);
	traceLog.attach(engine.getEventBus());
	logger.info({ tracesDir }, "Trace logging enabled");

	// --- Deep Sleep Pipeline ---
	const memoryEngine = new MemoryEngine(memoryDir);
	const deepSleepConfig = deepSleepConfigSchema.parse({});

	const deepSleepPipeline = new DeepSleepPipeline(
		memoryEngine,
		async (prompt: string) => {
			// Use engine to run an LLM call for entity extraction via memory-extractor agent (Sonnet).
			// If the agent doesn't exist, the extraction stage will fail gracefully
			// (other pipeline stages still run due to per-stage error isolation).
			const result = await engine.runAgent({
				agentName: "memory-extractor",
				prompt,
				traceId: `deep-sleep-extract-${Date.now()}`,
			});
			return result.output ?? "";
		},
		tracesDir,
		deepSleepConfig,
		() => {
			const agents = engine.getAgentRegistry().getAll();
			return agents.map((a) => ({
				name: a.name,
				team: a.reportsTo,
			}));
		},
		{ emit: (event) => engine.getEventBus().emit(event) },
		"orchestrator",
	);

	const deepSleepSchedule = process.env.MAXIMUS_DEEP_SLEEP_SCHEDULE ?? "0 3 * * *";
	scheduler.registerPipeline(
		{ id: "deep-sleep", name: "Deep Sleep Consolidation", schedule: deepSleepSchedule },
		() => deepSleepPipeline.run().then(() => {}),
	);

	const { server, bridge } = createApp(engine, scheduler, memoryEngine, {
		tracesDir,
		runPipeline: () => deepSleepPipeline.run(),
	}, tracesDir);

	server.listen(port, () => {
		logger.info({ port }, "Maximus server listening");
		scheduler.start();
	});

	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) process.exit(1);
		shuttingDown = true;
		logger.info("Shutting down...");
		scheduler.stop();
		traceLog.detach();
		server.close();
		bridge.destroy();
		void memoryEngine.close();
		engine.shutdown();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	return { server, engine, bridge, scheduler, traceLog };
}

/* istanbul ignore next -- auto-start guard */
if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
	bootstrap().catch((err) => {
		logger.error(err, "Failed to start");
		process.exit(1);
	});
}
