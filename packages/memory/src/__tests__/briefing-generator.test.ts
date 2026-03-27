import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteClient } from "../sqlite/client.js";
import { BriefingStore } from "../sqlite/briefing-store.js";
import { BriefingGenerator } from "../briefing/briefing-generator.js";
import { StrategyRegistry } from "../sqlite/strategy-registry.js";
import type { Episode, Briefing } from "@maximus/shared";

let tmpDir: string;
let client: SqliteClient;
let briefingStore: BriefingStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "briefing-gen-test-"));
	client = SqliteClient.open(join(tmpDir, "test.db"));
	briefingStore = new BriefingStore(client.raw);
});

afterEach(() => {
	client.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

const makeEpisode = (overrides: Partial<Episode> = {}): Episode => ({
	id: "ep-1",
	agentName: "agent-alpha",
	timestamp: Date.now(),
	taskDescription: "Send campaign emails",
	outcome: "success",
	lessonsLearned: ["Always check rate limits"],
	effectiveStrategies: ["Batch processing"],
	failurePatterns: [],
	toolsUsed: ["instantly-api"],
	tags: ["email"],
	utilityScore: 0.8,
	retrievalCount: 0,
	...overrides,
});

describe("BriefingStore", () => {
	it("Test 1: save persists and get retrieves by agentName", () => {
		const briefing: Briefing = {
			agentName: "agent-alpha",
			content: "## Session Briefing\nTest content",
			generatedAt: new Date().toISOString(),
			episodeIds: ["ep-1", "ep-2"],
			invalidated: false,
		};

		briefingStore.save(briefing);
		const retrieved = briefingStore.get("agent-alpha");

		expect(retrieved).not.toBeNull();
		expect(retrieved!.agentName).toBe("agent-alpha");
		expect(retrieved!.content).toBe("## Session Briefing\nTest content");
		expect(retrieved!.episodeIds).toEqual(["ep-1", "ep-2"]);
		expect(retrieved!.invalidated).toBe(false);
	});

	it("Test 2: invalidate sets invalidated flag", () => {
		const briefing: Briefing = {
			agentName: "agent-alpha",
			content: "## Session Briefing",
			generatedAt: new Date().toISOString(),
			episodeIds: [],
			invalidated: false,
		};

		briefingStore.save(briefing);
		briefingStore.invalidate("agent-alpha");
		const retrieved = briefingStore.get("agent-alpha");

		expect(retrieved).not.toBeNull();
		expect(retrieved!.invalidated).toBe(true);
	});

	it("Test 3: get returns null when no briefing exists", () => {
		const result = briefingStore.get("nonexistent-agent");
		expect(result).toBeNull();
	});

	it("Test 4: isValid returns false when briefing is invalidated or missing", () => {
		// Missing
		expect(briefingStore.isValid("nonexistent")).toBe(false);

		// Invalidated
		briefingStore.save({
			agentName: "agent-alpha",
			content: "content",
			generatedAt: new Date().toISOString(),
			episodeIds: [],
			invalidated: false,
		});
		briefingStore.invalidate("agent-alpha");
		expect(briefingStore.isValid("agent-alpha")).toBe(false);

		// Valid
		briefingStore.save({
			agentName: "agent-beta",
			content: "content",
			generatedAt: new Date().toISOString(),
			episodeIds: [],
			invalidated: false,
		});
		expect(briefingStore.isValid("agent-beta")).toBe(true);
	});
});

describe("BriefingGenerator", () => {
	// Mock EpisodeStore and KnowledgeStore
	const createMockEpisodeStore = (episodes: Episode[] = []) => ({
		getByAgent: vi.fn().mockReturnValue(episodes),
	});

	const createMockKnowledgeStore = (triples: any[] = []) => ({
		getByScope: vi.fn().mockResolvedValue(triples),
	});

	it("Test 5: generate produces markdown with Session Briefing heading", async () => {
		const episodeStore = createMockEpisodeStore([makeEpisode()]);
		const knowledgeStore = createMockKnowledgeStore();
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).not.toBeNull();
		expect(result!).toContain("## Session Briefing for agent-alpha");
	});

	it("Test 6: generate includes recent failures with episode lessons", async () => {
		const failedEp = makeEpisode({
			id: "ep-fail",
			outcome: "failure",
			taskDescription: "Deploy service",
			lessonsLearned: ["Check disk space first"],
		});
		const episodeStore = createMockEpisodeStore([failedEp]);
		const knowledgeStore = createMockKnowledgeStore();
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).not.toBeNull();
		expect(result!).toContain("### Recent Lessons");
		expect(result!).toContain("failure");
		expect(result!).toContain("Check disk space first");
	});

	it("Test 7: generate includes knowledge section with entity-predicate-target", async () => {
		const episodeStore = createMockEpisodeStore([makeEpisode()]);
		const knowledgeStore = createMockKnowledgeStore([
			{
				entity: { id: "e1", name: "Instantly API", type: "api", createdBy: "agent-alpha", firstSeen: 1000, lastUpdated: 1000 },
				triple: { sourceId: "e1", targetId: "e2", predicate: "rate_limited_by", scope: "agent", validFrom: 1000, confidence: 0.95, createdBy: "agent-alpha" },
				target: { id: "e2", name: "10 req/sec", type: "limit", createdBy: "agent-alpha", firstSeen: 1000, lastUpdated: 1000 },
			},
		]);
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).not.toBeNull();
		expect(result!).toContain("### Key Knowledge");
		expect(result!).toContain("Instantly API");
		expect(result!).toContain("rate_limited_by");
		expect(result!).toContain("10 req/sec");
		expect(result!).toContain("0.95");
	});

	it("Test 8: generate truncates output to token budget", async () => {
		// Create many episodes to exceed a small budget
		const episodes = Array.from({ length: 20 }, (_, i) =>
			makeEpisode({
				id: `ep-${i}`,
				taskDescription: `Task number ${i} with a long description that takes up space in the briefing`,
				lessonsLearned: [`Lesson learned from task ${i} that is quite verbose and detailed`],
				effectiveStrategies: [`Strategy ${i}: Do everything the long way to fill up budget`],
			}),
		);
		const episodeStore = createMockEpisodeStore(episodes);
		const knowledgeStore = createMockKnowledgeStore([
			{
				entity: { id: "e1", name: "API", type: "api", createdBy: "a", firstSeen: 1, lastUpdated: 1 },
				triple: { sourceId: "e1", targetId: "e2", predicate: "uses", scope: "agent", validFrom: 1, confidence: 0.8, createdBy: "a" },
				target: { id: "e2", name: "Endpoint", type: "endpoint", createdBy: "a", firstSeen: 1, lastUpdated: 1 },
			},
		]);
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
		);

		const result = await generator.generate("agent-alpha", [], 500);
		expect(result).not.toBeNull();
		expect(result!.length).toBeLessThanOrEqual(500);
	});

	it("Test 9: generate returns null when agent has no episodes and no knowledge", async () => {
		const episodeStore = createMockEpisodeStore([]);
		const knowledgeStore = createMockKnowledgeStore([]);
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).toBeNull();
	});

	it("Test 10: generate caches result and returns cached version if valid", async () => {
		const episodeStore = createMockEpisodeStore([makeEpisode()]);
		const knowledgeStore = createMockKnowledgeStore();
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
		);

		// First call generates and caches
		const result1 = await generator.generate("agent-alpha", []);
		expect(result1).not.toBeNull();
		expect(episodeStore.getByAgent).toHaveBeenCalledTimes(1);

		// Second call returns cached version
		const result2 = await generator.generate("agent-alpha", []);
		expect(result2).toBe(result1);
		// Should not have called getByAgent again (used cache)
		expect(episodeStore.getByAgent).toHaveBeenCalledTimes(1);
	});
});

describe("Performance Trends section", () => {
	const createMockEpisodeStore = (episodes: Episode[] = []) => ({
		getByAgent: vi.fn().mockReturnValue(episodes),
	});

	const createMockKnowledgeStore = (triples: any[] = []) => ({
		getByScope: vi.fn().mockResolvedValue(triples),
	});

	const createMockMetricsTracker = (overrides: {
		computeAndStore?: any;
		getByWindow?: any;
	} = {}) => ({
		computeAndStore: vi.fn().mockReturnValue({
			successRate: 0.8,
			avgTurns: 5,
			avgCostUsd: 0.0123,
			avgDurationMs: 30000,
			totalSessions: 5,
			windowStart: Date.now() - 7 * 86_400_000,
			windowEnd: Date.now(),
			...overrides.computeAndStore,
		}),
		getByWindow: vi.fn().mockReturnValue(
			overrides.getByWindow ?? [
				{ successRate: 0.6, totalSessions: 4 },
			],
		),
	});

	it("includes Performance Trends when agent has 5+ episodes and MetricsTracker", async () => {
		const episodes = Array.from({ length: 5 }, (_, i) =>
			makeEpisode({ id: `ep-${i}` }),
		);
		const episodeStore = createMockEpisodeStore(episodes);
		const knowledgeStore = createMockKnowledgeStore();
		const metricsTracker = createMockMetricsTracker();
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
			metricsTracker as any,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).not.toBeNull();
		expect(result!).toContain("### Performance Trends");
		expect(result!).toContain("Success Rate: 80%");
		expect(result!).toContain("UP");
	});

	it("skips Performance Trends with fewer than 3 episodes", async () => {
		const episodes = [
			makeEpisode({ id: "ep-1" }),
			makeEpisode({ id: "ep-2" }),
		];
		const episodeStore = createMockEpisodeStore(episodes);
		const knowledgeStore = createMockKnowledgeStore();
		const metricsTracker = createMockMetricsTracker();
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
			metricsTracker as any,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).not.toBeNull();
		expect(result!).not.toContain("Performance Trends");
	});

	it("skips Performance Trends when no MetricsTracker provided (backward compat)", async () => {
		const episodes = Array.from({ length: 5 }, (_, i) =>
			makeEpisode({ id: `ep-${i}` }),
		);
		const episodeStore = createMockEpisodeStore(episodes);
		const knowledgeStore = createMockKnowledgeStore();
		// No MetricsTracker - 3 arg constructor
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).not.toBeNull();
		expect(result!).not.toContain("Performance Trends");
	});

	it("shows failure concentration when failures exist", async () => {
		const episodes = Array.from({ length: 5 }, (_, i) =>
			makeEpisode({
				id: `ep-${i}`,
				outcome: i < 3 ? "failure" : "success",
				taskDescription: i < 3 ? "Deploy service" : "Send emails",
			}),
		);
		const episodeStore = createMockEpisodeStore(episodes);
		const knowledgeStore = createMockKnowledgeStore();
		const metricsTracker = createMockMetricsTracker({
			computeAndStore: { successRate: 0.4, totalSessions: 5 },
		});
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
			metricsTracker as any,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).not.toBeNull();
		expect(result!).toContain("Failure concentration");
		expect(result!).toContain("Deploy service");
		expect(result!).toContain("3 failures");
	});

	it("shows STABLE indicator when success rates are within 5%", async () => {
		const episodes = Array.from({ length: 5 }, (_, i) =>
			makeEpisode({ id: `ep-${i}` }),
		);
		const episodeStore = createMockEpisodeStore(episodes);
		const knowledgeStore = createMockKnowledgeStore();
		const metricsTracker = createMockMetricsTracker({
			computeAndStore: { successRate: 0.82, totalSessions: 5 },
			getByWindow: [{ successRate: 0.80, totalSessions: 4 }],
		});
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
			metricsTracker as any,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).not.toBeNull();
		expect(result!).toContain("STABLE");
	});

	it("shows DOWN indicator when success rate drops significantly", async () => {
		const episodes = Array.from({ length: 5 }, (_, i) =>
			makeEpisode({ id: `ep-${i}` }),
		);
		const episodeStore = createMockEpisodeStore(episodes);
		const knowledgeStore = createMockKnowledgeStore();
		const metricsTracker = createMockMetricsTracker({
			computeAndStore: { successRate: 0.4, totalSessions: 5 },
			getByWindow: [{ successRate: 0.8, totalSessions: 4 }],
		});
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
			metricsTracker as any,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).not.toBeNull();
		expect(result!).toContain("DOWN");
	});
});

describe("Proven Strategies section", () => {
	const createMockEpisodeStore = (episodes: Episode[] = []) => ({
		getByAgent: vi.fn().mockReturnValue(episodes),
	});

	const createMockKnowledgeStore = (triples: any[] = []) => ({
		getByScope: vi.fn().mockResolvedValue(triples),
	});

	it("shows strategies with usage counts and success rates when StrategyRegistry is provided", async () => {
		const episodes = [makeEpisode()];
		const episodeStore = createMockEpisodeStore(episodes);
		const knowledgeStore = createMockKnowledgeStore();
		const strategyRegistry = new StrategyRegistry(client.raw);

		// Record same strategy multiple times to exceed usageCount >= 2 filter
		strategyRegistry.record("agent-alpha", "Batch processing", "success");
		strategyRegistry.record("agent-alpha", "Batch processing", "success");
		strategyRegistry.record("agent-alpha", "Batch processing", "failure");

		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
			undefined,
			strategyRegistry,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).not.toBeNull();
		expect(result!).toContain("### Proven Strategies");
		expect(result!).toContain("**Batch processing**");
		expect(result!).toContain("used 3x");
		expect(result!).toContain("67% success rate");
	});

	it("falls back to episode-based strategies when no StrategyRegistry", async () => {
		const episodes = [makeEpisode({ effectiveStrategies: ["Retry on failure"] })];
		const episodeStore = createMockEpisodeStore(episodes);
		const knowledgeStore = createMockKnowledgeStore();

		// No StrategyRegistry - 3 arg constructor
		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).not.toBeNull();
		expect(result!).toContain("### Active Strategies");
		expect(result!).toContain("Retry on failure");
		expect(result!).not.toContain("### Proven Strategies");
	});

	it("filters out strategies with usageCount < 2", async () => {
		const episodes = [makeEpisode()];
		const episodeStore = createMockEpisodeStore(episodes);
		const knowledgeStore = createMockKnowledgeStore();
		const strategyRegistry = new StrategyRegistry(client.raw);

		// Record strategy only once - should be filtered out
		strategyRegistry.record("agent-alpha", "One-time strategy", "success");
		// Record another strategy twice - should appear
		strategyRegistry.record("agent-alpha", "Proven strategy", "success");
		strategyRegistry.record("agent-alpha", "Proven strategy", "success");

		const generator = new BriefingGenerator(
			episodeStore as any,
			knowledgeStore as any,
			briefingStore,
			undefined,
			strategyRegistry,
		);

		const result = await generator.generate("agent-alpha", []);
		expect(result).not.toBeNull();
		expect(result!).toContain("### Proven Strategies");
		expect(result!).toContain("Proven strategy");
		expect(result!).not.toContain("One-time strategy");
	});
});
