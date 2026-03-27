import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KuzuClient } from "../kuzu/client.js";
import { KnowledgeStore } from "../kuzu/knowledge-store.js";
import {
	EntityExtractor,
	type LlmFn,
	type ExtractionResult,
} from "../extract/entity-extractor.js";
import type { Episode } from "@maximus/shared";

let tmpDir: string;
let client: KuzuClient;
let store: KnowledgeStore;

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

beforeEach(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), "ee-test-"));
	client = await KuzuClient.open(join(tmpDir, "test.kuzu"));
	store = await KnowledgeStore.create(client);
});

afterEach(async () => {
	await client.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("EntityExtractor", () => {
	it("Test 1: extractFromEpisodes with mock LLM returns entities and triples", async () => {
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(validLlmResponse);
		const extractor = new EntityExtractor(store, mockLlm);

		const result = await extractor.extractFromEpisodes([makeEpisode()]);

		expect(result.entities.length).toBe(2);
		expect(result.triples.length).toBe(1);
		expect(result.entities[0].name).toBe("deploy-tool");
		expect(result.entities[0].type).toBe("tool");
		expect(result.triples[0].predicate).toBe("deploys_to");
		expect(result.triples[0].confidence).toBe(0.9);
	});

	it("Test 2: extractFromEpisodes calls KnowledgeStore methods", async () => {
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(validLlmResponse);
		const extractor = new EntityExtractor(store, mockLlm);

		const upsertSpy = vi.spyOn(store, "upsertEntity");
		const insertSpy = vi.spyOn(store, "insertTripleWithSupersession");

		await extractor.extractFromEpisodes([makeEpisode()]);

		expect(upsertSpy).toHaveBeenCalledTimes(2); // 2 entities
		expect(insertSpy).toHaveBeenCalledTimes(1); // 1 triple
	});

	it("Test 3: handles LLM returning JSON wrapped in markdown code fences", async () => {
		const fencedResponse = "```json\n" + validLlmResponse + "\n```";
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(fencedResponse);
		const extractor = new EntityExtractor(store, mockLlm);

		const result = await extractor.extractFromEpisodes([makeEpisode()]);

		expect(result.entities.length).toBe(2);
		expect(result.triples.length).toBe(1);
	});

	it("Test 4: returns empty result when LLM returns unparseable output", async () => {
		const mockLlm: LlmFn = vi
			.fn()
			.mockResolvedValue("I cannot extract entities from this text.");
		const extractor = new EntityExtractor(store, mockLlm);

		const result = await extractor.extractFromEpisodes([makeEpisode()]);

		expect(result.entities).toEqual([]);
		expect(result.triples).toEqual([]);
	});

	it("Test 5: uses LLM-tagged agentName on triples when present and valid", async () => {
		const multiAgentResponse = JSON.stringify({
			entities: [
				{ name: "deploy-tool", type: "tool" },
				{ name: "staging-env", type: "concept" },
			],
			relationships: [
				{ source: "deploy-tool", predicate: "deploys_to", target: "staging-env", confidence: 0.9, agentName: "agent-beta" },
			],
		});
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(multiAgentResponse);
		const extractor = new EntityExtractor(store, mockLlm);

		const result = await extractor.extractFromEpisodes([
			makeEpisode({ agentName: "agent-alpha" }),
			makeEpisode({ id: "ep-2", agentName: "agent-beta" }),
		]);

		// agentName in LLM response is valid — should be used
		expect(result.triples[0].createdBy).toBe("agent-beta");
		expect(result.triples[0].scope).toBe("agent");
	});

	it("Test 5b: falls back to first episode agentName when LLM omits agentName", async () => {
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(validLlmResponse); // no agentName in relationships
		const extractor = new EntityExtractor(store, mockLlm);

		const result = await extractor.extractFromEpisodes([
			makeEpisode({ agentName: "my-special-agent" }),
		]);

		for (const triple of result.triples) {
			expect(triple.scope).toBe("agent");
			expect(triple.createdBy).toBe("my-special-agent");
		}
	});

	it("Test 6: buildPrompt includes episode fields in the prompt text", async () => {
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(validLlmResponse);
		const extractor = new EntityExtractor(store, mockLlm);

		await extractor.extractFromEpisodes([makeEpisode()]);

		const promptArg = (mockLlm as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as string;
		expect(promptArg).toContain("Deploy the API to staging");
		expect(promptArg).toContain("success");
		expect(promptArg).toContain("Always check rate limits");
		expect(promptArg).toContain("deploy-tool");
		expect(promptArg).toContain("curl");
	});

	it("Test 7: prompt includes operational knowledge guidance", () => {
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(validLlmResponse);
		const extractor = new EntityExtractor(store, mockLlm);

		const prompt = extractor.buildPrompt([makeEpisode()]);

		expect(prompt.toLowerCase()).toContain("operational knowledge");
		expect(prompt).toContain("BETTER next time");
	});

	it("Test 8: prompt includes strategy entity type", () => {
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(validLlmResponse);
		const extractor = new EntityExtractor(store, mockLlm);

		const prompt = extractor.buildPrompt([makeEpisode()]);

		expect(prompt).toContain("strategy");
		expect(prompt).toContain("discovered_by");
	});

	it("Test 9: prompt includes good and bad extraction examples", () => {
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(validLlmResponse);
		const extractor = new EntityExtractor(store, mockLlm);

		const prompt = extractor.buildPrompt([makeEpisode()]);

		expect(prompt).toContain("BAD EXTRACTIONS");
		expect(prompt).toContain("do NOT produce");
		expect(prompt).toContain("GOOD EXTRACTIONS");
	});

	it("Test 10: prompt does not contain old generic text", () => {
		const mockLlm: LlmFn = vi.fn().mockResolvedValue(validLlmResponse);
		const extractor = new EntityExtractor(store, mockLlm);

		const prompt = extractor.buildPrompt([makeEpisode()]);

		expect(prompt).not.toContain(
			"Extract entities and relationships from these agent experience episodes",
		);
	});
});
