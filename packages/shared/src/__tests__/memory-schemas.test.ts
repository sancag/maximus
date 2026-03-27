import { describe, it, expect } from "vitest";
import {
	episodeSchema,
	memoryConfigSchema,
	knowledgeTripleSchema,
	briefingSchema,
	agentFrontmatterSchema,
} from "../index.js";

describe("episodeSchema", () => {
	const validEpisode = {
		id: "ep-001",
		agentName: "worker-a",
		timestamp: Date.now(),
		taskDescription: "Process data",
		outcome: "success" as const,
		lessonsLearned: ["lesson1"],
		effectiveStrategies: ["strategy1"],
		failurePatterns: [],
		toolsUsed: ["tool1"],
		tags: ["tag1"],
	};

	it("parses a valid full Episode object", () => {
		const result = episodeSchema.parse({
			...validEpisode,
			turnCount: 5,
			costUsd: 0.01,
			durationMs: 3000,
			utilityScore: 0.8,
			retrievalCount: 3,
		});
		expect(result.id).toBe("ep-001");
		expect(result.outcome).toBe("success");
		expect(result.utilityScore).toBe(0.8);
		expect(result.retrievalCount).toBe(3);
	});

	it("applies defaults: utilityScore=0, retrievalCount=0", () => {
		const result = episodeSchema.parse(validEpisode);
		expect(result.utilityScore).toBe(0);
		expect(result.retrievalCount).toBe(0);
	});

	it("rejects invalid outcome", () => {
		expect(() =>
			episodeSchema.parse({ ...validEpisode, outcome: "unknown" }),
		).toThrow();
	});

	it("rejects missing required fields", () => {
		expect(() => episodeSchema.parse({ id: "ep-001" })).toThrow();
		expect(() =>
			episodeSchema.parse({ ...validEpisode, id: undefined }),
		).toThrow();
	});
});

describe("memoryConfigSchema", () => {
	it("parses empty object with all defaults", () => {
		const result = memoryConfigSchema.parse({});
		expect(result.episodic).toBe(true);
		expect(result.maxEpisodes).toBe(50);
		expect(result.knowledgeScopes).toEqual([]);
		expect(result.briefingEnabled).toBe(true);
		expect(result.learningRate).toBe("moderate");
	});

	it("parses full config with all fields overridden", () => {
		const result = memoryConfigSchema.parse({
			episodic: false,
			maxEpisodes: 200,
			knowledgeScopes: ["team-a"],
			briefingEnabled: false,
			learningRate: "aggressive",
		});
		expect(result.episodic).toBe(false);
		expect(result.maxEpisodes).toBe(200);
		expect(result.knowledgeScopes).toEqual(["team-a"]);
		expect(result.briefingEnabled).toBe(false);
		expect(result.learningRate).toBe("aggressive");
	});

	it("rejects maxEpisodes > 500", () => {
		expect(() =>
			memoryConfigSchema.parse({ maxEpisodes: 501 }),
		).toThrow();
	});

	it("rejects invalid learningRate value", () => {
		expect(() =>
			memoryConfigSchema.parse({ learningRate: "turbo" }),
		).toThrow();
	});
});

describe("knowledgeTripleSchema", () => {
	const validTriple = {
		sourceId: "e-1",
		targetId: "e-2",
		predicate: "DEPENDS_ON",
		scope: "team" as const,
		validFrom: Date.now(),
		confidence: 0.85,
		createdBy: "worker-a",
	};

	it("parses valid triple with confidence 0.85", () => {
		const result = knowledgeTripleSchema.parse(validTriple);
		expect(result.confidence).toBe(0.85);
		expect(result.scope).toBe("team");
	});

	it("rejects confidence > 1.0", () => {
		expect(() =>
			knowledgeTripleSchema.parse({ ...validTriple, confidence: 1.1 }),
		).toThrow();
	});

	it("rejects confidence < 0", () => {
		expect(() =>
			knowledgeTripleSchema.parse({ ...validTriple, confidence: -0.1 }),
		).toThrow();
	});

	it("validates scope enum", () => {
		for (const scope of ["agent", "team", "global"]) {
			expect(() =>
				knowledgeTripleSchema.parse({ ...validTriple, scope }),
			).not.toThrow();
		}
		expect(() =>
			knowledgeTripleSchema.parse({ ...validTriple, scope: "local" }),
		).toThrow();
	});
});

describe("agentFrontmatterSchema (memory extension)", () => {
	const baseAgent = {
		name: "test-agent",
		description: "A test agent",
	};

	it("parses agent without memory field (backward compatible)", () => {
		const result = agentFrontmatterSchema.parse(baseAgent);
		expect(result.memory).toBeUndefined();
	});

	it("parses agent with memory config", () => {
		const result = agentFrontmatterSchema.parse({
			...baseAgent,
			memory: { episodic: true, maxEpisodes: 100 },
		});
		expect(result.memory?.episodic).toBe(true);
		expect(result.memory?.maxEpisodes).toBe(100);
	});

	it("applies memory field defaults when memory: {} is provided", () => {
		const result = agentFrontmatterSchema.parse({
			...baseAgent,
			memory: {},
		});
		expect(result.memory?.episodic).toBe(true);
		expect(result.memory?.maxEpisodes).toBe(50);
		expect(result.memory?.learningRate).toBe("moderate");
	});
});

describe("briefingSchema", () => {
	it("parses valid briefing, invalidated defaults to false", () => {
		const result = briefingSchema.parse({
			agentName: "worker-a",
			content: "Briefing content",
			generatedAt: "2026-03-23T00:00:00Z",
			episodeIds: ["ep-001"],
		});
		expect(result.invalidated).toBe(false);
		expect(result.agentName).toBe("worker-a");
	});
});

describe("re-exports from index", () => {
	it("exports all key schemas from index", async () => {
		const mod = await import("../index.js");
		expect(mod.episodeSchema).toBeDefined();
		expect(mod.memoryConfigSchema).toBeDefined();
		expect(mod.knowledgeTripleSchema).toBeDefined();
		expect(mod.agentMetricsSchema).toBeDefined();
		expect(mod.briefingSchema).toBeDefined();
		expect(mod.knowledgeEntitySchema).toBeDefined();
	});
});
