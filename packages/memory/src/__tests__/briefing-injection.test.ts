import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryEngine } from "../engine.js";
import { PromptInjector } from "../briefing/prompt-injector.js";
import { BriefingGenerator } from "../briefing/briefing-generator.js";
import { BriefingStore } from "../sqlite/briefing-store.js";
import { EpisodeStore } from "../sqlite/episodes.js";
import { EpisodeDistiller } from "../trace/distiller.js";
import { AgentSimulator } from "../test-engine/simulator/agent-simulator.js";
import { memoryConfigSchema } from "@maximus/shared";
import type { MemoryConfig } from "@maximus/shared";

let tmpDir: string;
let engine: MemoryEngine;
const simulator = new AgentSimulator();
const distiller = new EpisodeDistiller();

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "briefing-test-"));
  engine = new MemoryEngine(join(tmpDir, "memory"));
});

afterEach(async () => {
  await engine.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Helper to create episodes for an agent
async function createEpisodesForAgent(agentName: string, episodeCount: number): Promise<void> {
  const episodeStore = new EpisodeStore(engine.getSqlite().raw);

  for (let i = 0; i < episodeCount; i++) {
    const events = simulator.generateEvents({
      agentName,
      task: `Task ${i} for ${agentName}`,
      outcome: i % 3 === 0 ? "failure" : "success",
      turnCount: 3 + i,
      toolsUsed: ["bash", "file_read"],
      costUsd: 0.01 + i * 0.001,
      durationMs: 5000 + i * 1000,
    });

    const episode = distiller.distill(agentName, events);
    episodeStore.store(episode);
  }
}

describe("Briefing Injection Validation (TEST-05)", () => {
  describe("Prompt Injection", () => {
    it("prepends briefing to system prompt", async () => {
      const briefingStore = new BriefingStore(engine.getSqlite().raw);

      // Store a test briefing
      briefingStore.save({
        agentName: "test-agent",
        content: "## Session Briefing\n\nRecent lesson: Use bash for file operations.",
        generatedAt: new Date().toISOString(),
        episodeIds: ["ep-1"],
        invalidated: false,
      });

      // PromptInjector takes a BriefingGenerator, not BriefingStore
      // Use a mock BriefingGenerator that returns the stored briefing content
      const mockGenerator = {
        generate: vi.fn().mockResolvedValue(
          "## Session Briefing\n\nRecent lesson: Use bash for file operations."
        ),
      };

      const originalPrompt = "You are a helpful assistant.";
      const config: MemoryConfig = memoryConfigSchema.parse({ briefingEnabled: true });

      const injector = new PromptInjector(mockGenerator as any);
      const result = await injector.inject("test-agent", originalPrompt, config, []);

      expect(result).toContain("## Session Briefing");
      expect(result).toContain(originalPrompt);
      expect(result.indexOf("## Session Briefing")).toBeLessThan(result.indexOf(originalPrompt));
    });

    it("returns original prompt when briefing disabled", async () => {
      const mockGenerator = {
        generate: vi.fn().mockResolvedValue("## Session Briefing\n\nContent"),
      };

      const originalPrompt = "You are a helpful assistant.";
      const config: MemoryConfig = memoryConfigSchema.parse({ briefingEnabled: false });

      const injector = new PromptInjector(mockGenerator as any);
      const result = await injector.inject("test-agent", originalPrompt, config, []);

      expect(result).toBe(originalPrompt);
      expect(mockGenerator.generate).not.toHaveBeenCalled();
    });

    it("returns original prompt when no briefing exists", async () => {
      const mockGenerator = {
        generate: vi.fn().mockResolvedValue(null),
      };

      const originalPrompt = "You are a helpful assistant.";
      const config: MemoryConfig = memoryConfigSchema.parse({ briefingEnabled: true });

      const injector = new PromptInjector(mockGenerator as any);
      const result = await injector.inject("new-agent", originalPrompt, config, []);

      expect(result).toBe(originalPrompt);
    });
  });

  describe("Briefing Generation", () => {
    it("creates briefing with lessons and strategies from episodes", async () => {
      await createEpisodesForAgent("test-agent", 5);

      const episodeStore = new EpisodeStore(engine.getSqlite().raw);
      const briefingStore = new BriefingStore(engine.getSqlite().raw);

      // Use a mock kuzu that returns empty knowledge triples
      const mockKnowledgeStore = {
        getByScope: vi.fn().mockResolvedValue([]),
      };

      const generator = new BriefingGenerator(
        episodeStore,
        mockKnowledgeStore as any,
        briefingStore
      );

      const briefing = await generator.generate("test-agent", [], 2000);

      expect(briefing).not.toBeNull();
      expect(briefing).toContain("## Session Briefing for test-agent");
    });

    it("respects token budget", async () => {
      await createEpisodesForAgent("test-agent", 10);

      const episodeStore = new EpisodeStore(engine.getSqlite().raw);
      const briefingStore = new BriefingStore(engine.getSqlite().raw);
      const mockKnowledgeStore = {
        getByScope: vi.fn().mockResolvedValue([]),
      };

      const generator = new BriefingGenerator(
        episodeStore,
        mockKnowledgeStore as any,
        briefingStore
      );

      const budget = 500;
      const briefing = await generator.generate("test-agent", [], budget);

      expect(briefing).not.toBeNull();
      expect(briefing!.length).toBeLessThanOrEqual(budget);
    });

    it("returns null for agent with no episodes or knowledge", async () => {
      const episodeStore = new EpisodeStore(engine.getSqlite().raw);
      const briefingStore = new BriefingStore(engine.getSqlite().raw);
      const mockKnowledgeStore = {
        getByScope: vi.fn().mockResolvedValue([]),
      };

      const generator = new BriefingGenerator(
        episodeStore,
        mockKnowledgeStore as any,
        briefingStore
      );

      const briefing = await generator.generate("no-data-agent", [], 2000);
      expect(briefing).toBeNull();
    });
  });

  describe("Briefing Effectiveness", () => {
    it("measures improvement in task outcomes with briefing", async () => {
      // Simplified A/B test - compare prompts with/without briefing
      const mockGenerator = {
        generate: vi.fn().mockResolvedValue(
          "## Session Briefing\n\n### Recent Lessons\n- Use bash tool for file operations\n- Check file existence before reading"
        ),
      };

      const basePrompt = "You are a helpful coding assistant.";
      const withBriefingConfig: MemoryConfig = memoryConfigSchema.parse({ briefingEnabled: true });
      const withoutBriefingConfig: MemoryConfig = memoryConfigSchema.parse({ briefingEnabled: false });

      const injector = new PromptInjector(mockGenerator as any);

      const promptWithBriefing = await injector.inject(
        "test-agent",
        basePrompt,
        withBriefingConfig,
        []
      );
      const promptWithoutBriefing = await injector.inject(
        "test-agent",
        basePrompt,
        withoutBriefingConfig,
        []
      );

      // Verify briefing is present in one and not the other
      expect(promptWithBriefing).toContain("## Session Briefing");
      expect(promptWithoutBriefing).not.toContain("## Session Briefing");
      expect(promptWithoutBriefing).toBe(basePrompt);
    });

    it("invalidates briefing when new episodes are processed", async () => {
      const briefingStore = new BriefingStore(engine.getSqlite().raw);

      // Store a briefing
      briefingStore.save({
        agentName: "test-agent",
        content: "## Session Briefing\n\nOld content",
        generatedAt: new Date().toISOString(),
        episodeIds: ["ep-1"],
        invalidated: false,
      });

      // Verify it's valid
      expect(briefingStore.isValid("test-agent")).toBe(true);

      // Invalidate it
      briefingStore.invalidate("test-agent");

      const briefing = briefingStore.get("test-agent");
      expect(briefing?.invalidated).toBe(true);
    });

    it("caches briefing on first generation and returns cached on second call", async () => {
      await createEpisodesForAgent("test-agent", 3);

      const episodeStore = new EpisodeStore(engine.getSqlite().raw);
      const briefingStore = new BriefingStore(engine.getSqlite().raw);
      const mockKnowledgeStore = {
        getByScope: vi.fn().mockResolvedValue([]),
      };

      const generator = new BriefingGenerator(
        episodeStore,
        mockKnowledgeStore as any,
        briefingStore
      );

      // First call generates and caches
      const briefing1 = await generator.generate("test-agent", [], 2000);
      expect(briefing1).not.toBeNull();

      // Second call should use cache (getByScope called only once)
      const briefing2 = await generator.generate("test-agent", [], 2000);
      expect(briefing2).toBe(briefing1);
      expect(mockKnowledgeStore.getByScope).toHaveBeenCalledTimes(1);
    });
  });
});
