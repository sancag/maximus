import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
	EntityExtractor,
	type LlmFn,
} from "../extract/entity-extractor.js";
import { SQLITE_SCHEMA_DDL } from "../sqlite/schema.js";
import type { Episode } from "@maximus/shared";
import type { KnowledgeStore } from "../kuzu/knowledge-store.js";

let sqliteDb: Database.Database;

/** Minimal mock KnowledgeStore that does nothing on upsert/insert */
const makeMockStore = (): KnowledgeStore =>
	({
		upsertEntity: vi.fn().mockResolvedValue(undefined),
		insertTripleWithSupersession: vi.fn().mockResolvedValue(undefined),
	}) as unknown as KnowledgeStore;

const makeEpisode = (overrides: Partial<Episode> = {}): Episode => ({
	id: "ep-1",
	agentName: "agent-alpha",
	timestamp: 1000,
	taskDescription: "Deploy the API to staging",
	outcome: "success",
	lessonsLearned: ["Always check rate limits before bulk operations"],
	effectiveStrategies: ["Used retry with backoff"],
	failurePatterns: [],
	toolsUsed: ["deploy-tool", "curl"],
	tags: ["deployment", "api"],
	utilityScore: 0,
	retrievalCount: 0,
	...overrides,
});

const validLlmResponse = JSON.stringify({
	entities: [
		{ name: "deploy-tool", type: "tool", attributes: { version: "2.1" } },
		{ name: "staging-env", type: "concept", attributes: {} },
	],
	relationships: [
		{
			source: "deploy-tool",
			predicate: "deploys_to",
			target: "staging-env",
			confidence: 0.9,
		},
	],
});

beforeEach(() => {
	sqliteDb = new Database(":memory:");
	sqliteDb.exec(SQLITE_SCHEMA_DDL);
});

afterEach(() => {
	sqliteDb.close();
});

describe("Prompt Versioning", () => {
	it("same prompt produces same version ID (idempotent)", async () => {
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(validLlmResponse);
		const extractor = new EntityExtractor(makeMockStore(), mockLlm, sqliteDb);

		// Two calls with same episodes produce same prompt
		await extractor.extractFromEpisodes([makeEpisode()]);
		await extractor.extractFromEpisodes([makeEpisode()]);

		const rows = sqliteDb
			.prepare("SELECT * FROM prompt_versions")
			.all() as Array<Record<string, unknown>>;

		// Same prompt text -> same hash -> only 1 version row
		expect(rows.length).toBe(1);
	});

	it("different prompts produce different version IDs", async () => {
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(validLlmResponse);
		const extractor = new EntityExtractor(makeMockStore(), mockLlm, sqliteDb);

		// First call with agent-alpha
		await extractor.extractFromEpisodes([makeEpisode()]);

		// Second call with different agent name produces different prompt text
		await extractor.extractFromEpisodes([
			makeEpisode({ agentName: "agent-beta", id: "ep-2" }),
		]);

		const rows = sqliteDb
			.prepare("SELECT * FROM prompt_versions")
			.all() as Array<Record<string, unknown>>;

		expect(rows.length).toBe(2);
	});

	it("records extraction metrics with correct counts", async () => {
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(validLlmResponse);
		const extractor = new EntityExtractor(makeMockStore(), mockLlm, sqliteDb);

		await extractor.extractFromEpisodes([makeEpisode()]);

		const rows = sqliteDb
			.prepare("SELECT * FROM extraction_metrics")
			.all() as Array<Record<string, unknown>>;

		expect(rows.length).toBe(1);
		expect(rows[0].episodesProcessed).toBe(1);
		expect(rows[0].entitiesExtracted).toBe(2);
		expect(rows[0].triplesExtracted).toBe(1);
		expect(rows[0].entitiesPerEpisode).toBe(2); // 2 entities / 1 episode
		expect(rows[0].triplesPerEpisode).toBe(1); // 1 triple / 1 episode
	});

	it("works without db parameter (backward compat)", async () => {
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(validLlmResponse);
		// No db parameter
		const extractor = new EntityExtractor(makeMockStore(), mockLlm);

		const result = await extractor.extractFromEpisodes([makeEpisode()]);

		// Should not crash and should return valid results
		expect(result.entities.length).toBe(2);
		expect(result.triples.length).toBe(1);
	});

	it("unique entity ratio computed correctly", async () => {
		// LLM returns 3 entities with 2 unique names
		const duplicateResponse = JSON.stringify({
			entities: [
				{ name: "deploy-tool", type: "tool" },
				{ name: "staging-env", type: "concept" },
				{ name: "deploy-tool", type: "tool" }, // duplicate name
			],
			relationships: [],
		});
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(duplicateResponse);
		const extractor = new EntityExtractor(makeMockStore(), mockLlm, sqliteDb);

		await extractor.extractFromEpisodes([makeEpisode()]);

		const rows = sqliteDb
			.prepare("SELECT uniqueEntityRatio FROM extraction_metrics")
			.all() as Array<{ uniqueEntityRatio: number }>;

		expect(rows.length).toBe(1);
		// 2 unique names / 3 total entities = 0.6667
		expect(rows[0].uniqueEntityRatio).toBeCloseTo(0.667, 2);
	});
});
