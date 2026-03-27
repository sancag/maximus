import { describe, it, expect, vi } from "vitest";
import { PromptInjector } from "../briefing/prompt-injector.js";
import type { MemoryConfig } from "@maximus/shared";

describe("PromptInjector", () => {
	const createMockGenerator = (briefing: string | null = "## Session Briefing\nContent") => ({
		generate: vi.fn().mockResolvedValue(briefing),
	});

	it("Test 1: inject returns briefing + newlines + originalPrompt when briefing is generated", async () => {
		const generator = createMockGenerator("## Session Briefing\nHello");
		const injector = new PromptInjector(generator as any);
		const memoryConfig: MemoryConfig = {
			episodic: true,
			maxEpisodes: 50,
			knowledgeScopes: [],
			briefingEnabled: true,
			briefingTokenBudget: 2000,
			learningRate: "moderate",
		};

		const result = await injector.inject("agent-alpha", "You are a helpful agent.", memoryConfig, []);
		expect(result).toBe("## Session Briefing\nHello\n\nYou are a helpful agent.");
	});

	it("Test 2: inject returns originalPrompt unchanged when briefingEnabled is false", async () => {
		const generator = createMockGenerator();
		const injector = new PromptInjector(generator as any);
		const memoryConfig: MemoryConfig = {
			episodic: true,
			maxEpisodes: 50,
			knowledgeScopes: [],
			briefingEnabled: false,
			briefingTokenBudget: 2000,
			learningRate: "moderate",
		};

		const result = await injector.inject("agent-alpha", "You are a helpful agent.", memoryConfig, []);
		expect(result).toBe("You are a helpful agent.");
		expect(generator.generate).not.toHaveBeenCalled();
	});

	it("Test 3: inject returns originalPrompt unchanged when BriefingGenerator.generate returns null", async () => {
		const generator = createMockGenerator(null);
		const injector = new PromptInjector(generator as any);
		const memoryConfig: MemoryConfig = {
			episodic: true,
			maxEpisodes: 50,
			knowledgeScopes: [],
			briefingEnabled: true,
			briefingTokenBudget: 2000,
			learningRate: "moderate",
		};

		const result = await injector.inject("agent-alpha", "You are a helpful agent.", memoryConfig, []);
		expect(result).toBe("You are a helpful agent.");
	});

	it("Test 4: inject uses briefingTokenBudget from memoryConfig", async () => {
		const generator = createMockGenerator("## Briefing");
		const injector = new PromptInjector(generator as any);
		const memoryConfig: MemoryConfig = {
			episodic: true,
			maxEpisodes: 50,
			knowledgeScopes: [],
			briefingEnabled: true,
			briefingTokenBudget: 5000,
			learningRate: "moderate",
		};

		await injector.inject("agent-alpha", "prompt", memoryConfig, ["teammate"]);
		expect(generator.generate).toHaveBeenCalledWith("agent-alpha", ["teammate"], 5000);
	});

	it("Test 5: inject does NOT mutate the original prompt string reference", async () => {
		const generator = createMockGenerator("## Briefing");
		const injector = new PromptInjector(generator as any);
		const original = "You are a helpful agent.";
		const memoryConfig: MemoryConfig = {
			episodic: true,
			maxEpisodes: 50,
			knowledgeScopes: [],
			briefingEnabled: true,
			briefingTokenBudget: 2000,
			learningRate: "moderate",
		};

		const result = await injector.inject("agent-alpha", original, memoryConfig, []);
		// Original string should be unchanged (strings are immutable in JS, but verify result is different)
		expect(result).not.toBe(original);
		expect(original).toBe("You are a helpful agent.");
		// Result should be a new string
		expect(result).toContain("## Briefing");
		expect(result).toContain("You are a helpful agent.");
	});
});
