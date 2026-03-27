import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSimulator } from "../test-engine/simulator/agent-simulator.js";
import { TraceGenerator } from "../test-engine/simulator/trace-generator.js";
import { ScenarioGenerator } from "../test-engine/simulator/scenario-generator.js";
import { EpisodeValidator } from "../test-engine/validators/episode-validator.js";
import type { Episode } from "@maximus/shared";

let tmpDir: string;
let tracesDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "simulator-test-"));
  tracesDir = join(tmpDir, "traces");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("AgentSimulator", () => {
  it("generates events with session:start first and session:end last", () => {
    const simulator = new AgentSimulator();
    const events = simulator.generateEvents({
      agentName: "test-agent",
      task: "Test task",
      outcome: "success",
      turnCount: 2,
      toolsUsed: [],
      costUsd: 0.01,
      durationMs: 5000,
    });

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].type).toBe("session:start");
    expect(events[events.length - 1].type).toBe("session:end");
  });

  it("generates correct number of message events based on turnCount", () => {
    const simulator = new AgentSimulator();
    const events = simulator.generateEvents({
      agentName: "test-agent",
      task: "Test task",
      outcome: "success",
      turnCount: 5,
      toolsUsed: [],
      costUsd: 0.01,
      durationMs: 5000,
    });

    const messageEvents = events.filter((e) => e.type === "agent:message");
    expect(messageEvents.length).toBe(5);
  });

  it("includes tool events when toolsUsed specified", () => {
    const simulator = new AgentSimulator();
    const events = simulator.generateEvents({
      agentName: "test-agent",
      task: "Test task",
      outcome: "success",
      turnCount: 4,
      toolsUsed: ["bash", "file_read"],
      costUsd: 0.01,
      durationMs: 5000,
    });

    const toolCalls = events.filter((e) => e.type === "agent:tool_call");
    const toolResults = events.filter((e) => e.type === "agent:tool_result");
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolResults.length).toBeGreaterThan(0);
    expect(toolCalls.length).toBe(toolResults.length);
  });

  it("includes delegation events when configured", () => {
    const simulator = new AgentSimulator();
    const events = simulator.generateEvents({
      agentName: "test-agent",
      task: "Test task",
      outcome: "partial",
      turnCount: 2,
      toolsUsed: [],
      costUsd: 0.01,
      durationMs: 5000,
      includeDelegation: true,
      delegatedTo: "other-agent",
    });

    const delegationEvents = events.filter((e) => e.type === "agent:delegation");
    expect(delegationEvents.length).toBe(1);
    expect(delegationEvents[0].payload.to).toBe("other-agent");
  });

  it("generates agent:completion for success outcome", () => {
    const simulator = new AgentSimulator();
    const events = simulator.generateEvents({
      agentName: "test-agent",
      task: "Task",
      outcome: "success",
      turnCount: 1,
      toolsUsed: [],
      costUsd: 0.01,
      durationMs: 3000,
    });

    expect(events.some((e) => e.type === "agent:completion")).toBe(true);
    expect(events.some((e) => e.type === "agent:error")).toBe(false);
  });

  it("generates agent:error for failure outcome", () => {
    const simulator = new AgentSimulator();
    const events = simulator.generateEvents({
      agentName: "test-agent",
      task: "Task",
      outcome: "failure",
      turnCount: 1,
      toolsUsed: [],
      costUsd: 0.01,
      durationMs: 3000,
    });

    expect(events.some((e) => e.type === "agent:error")).toBe(true);
    expect(events.some((e) => e.type === "agent:completion")).toBe(false);
  });
});

describe("TraceGenerator", () => {
  it("writes valid JSONL that can be read back", () => {
    const simulator = new AgentSimulator();
    const generator = new TraceGenerator(tracesDir);

    const events = simulator.generateEvents({
      agentName: "test-agent",
      task: "Test task",
      outcome: "success",
      turnCount: 2,
      toolsUsed: [],
      costUsd: 0.01,
      durationMs: 5000,
    });

    const traceId = generator.writeTrace(events);
    const content = readFileSync(join(tracesDir, `${traceId}.jsonl`), "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(events.length);
    lines.forEach((line) => {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("type");
      expect(parsed).toHaveProperty("timestamp");
    });
  });

  it("throws when trace exists and overwrite is false", () => {
    const simulator = new AgentSimulator();
    const generator = new TraceGenerator(tracesDir);

    const events = simulator.generateEvents({
      agentName: "test-agent",
      task: "Test task",
      outcome: "success",
      turnCount: 2,
      toolsUsed: [],
      costUsd: 0.01,
      durationMs: 5000,
    });

    generator.writeTrace(events, { traceId: "duplicate" });
    expect(() => generator.writeTrace(events, { traceId: "duplicate" })).toThrow();
  });
});

describe("EpisodeValidator", () => {
  it("passes valid Episode objects", () => {
    const validator = new EpisodeValidator();
    const episode: Episode = {
      id: "ep-1",
      agentName: "test-agent",
      timestamp: Date.now(),
      taskDescription: "Test task",
      outcome: "success",
      lessonsLearned: ["lesson1"],
      effectiveStrategies: ["strategy1"],
      failurePatterns: [],
      toolsUsed: ["bash"],
      tags: ["test"],
      utilityScore: 0.5,
      retrievalCount: 0,
    };

    const result = validator.validate(episode);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.episode).toEqual(episode);
  });

  it("fails invalid Episode objects with descriptive errors", () => {
    const validator = new EpisodeValidator();
    const invalidEpisode = {
      id: "ep-1",
      agentName: "test-agent",
      // missing required fields
    };

    const result = validator.validate(invalidEpisode);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("validates expected outcome when checkOutcome is true", () => {
    const validator = new EpisodeValidator();
    const episode: Episode = {
      id: "ep-1",
      agentName: "test-agent",
      timestamp: Date.now(),
      taskDescription: "Test task",
      outcome: "failure",
      lessonsLearned: [],
      effectiveStrategies: [],
      failurePatterns: ["error"],
      toolsUsed: [],
      tags: [],
      utilityScore: 0.1,
      retrievalCount: 0,
    };

    const result = validator.validate(episode, {
      checkOutcome: true,
      expectedOutcome: "success",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("outcome"))).toBe(true);
  });
});

describe("ScenarioGenerator", () => {
  it("provides at least 5 predefined scenarios", () => {
    const generator = new ScenarioGenerator();
    const scenarios = generator.listScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(5);
  });

  it("generates events for each scenario", () => {
    const generator = new ScenarioGenerator();
    const scenarios = generator.listScenarios();

    for (const name of scenarios) {
      const events = generator.generate(name, "test-agent");
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe("session:start");
    }
  });
});
