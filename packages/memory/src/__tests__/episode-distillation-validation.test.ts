import { describe, it, expect } from "vitest";
import { EpisodeDistiller } from "../trace/distiller.js";
import { AgentSimulator } from "../test-engine/simulator/agent-simulator.js";
import { EpisodeValidator } from "../test-engine/validators/episode-validator.js";
import type { AgentEvent } from "@maximus/shared";

describe("Episode Distillation Validation (TEST-02)", () => {
  const distiller = new EpisodeDistiller();
  const simulator = new AgentSimulator();
  const validator = new EpisodeValidator();

  describe("Outcome Determination", () => {
    it("produces success outcome when completion event present", () => {
      const events = simulator.generateEvents({
        agentName: "test-agent",
        task: "Test task",
        outcome: "success",
        turnCount: 2,
        toolsUsed: [],
        costUsd: 0.01,
        durationMs: 5000,
      });

      const episode = distiller.distill("test-agent", events);
      const validation = validator.validate(episode, {
        checkOutcome: true,
        expectedOutcome: "success",
      });

      expect(validation.valid).toBe(true);
      expect(episode.outcome).toBe("success");
    });

    it("produces failure outcome when error event present", () => {
      const events = simulator.generateEvents({
        agentName: "test-agent",
        task: "Test task",
        outcome: "failure",
        turnCount: 2,
        toolsUsed: [],
        costUsd: 0.01,
        durationMs: 5000,
      });

      const episode = distiller.distill("test-agent", events);
      const validation = validator.validate(episode, {
        checkOutcome: true,
        expectedOutcome: "failure",
      });

      expect(validation.valid).toBe(true);
      expect(episode.outcome).toBe("failure");
    });

    it("produces partial outcome when neither completion nor error", () => {
      const events = simulator.generateEvents({
        agentName: "test-agent",
        task: "Test task",
        outcome: "partial",
        turnCount: 2,
        toolsUsed: [],
        costUsd: 0.01,
        durationMs: 5000,
      });

      const episode = distiller.distill("test-agent", events);
      const validation = validator.validate(episode, {
        checkOutcome: true,
        expectedOutcome: "partial",
      });

      expect(validation.valid).toBe(true);
      expect(episode.outcome).toBe("partial");
    });
  });

  describe("Metric Accuracy", () => {
    it("turn count equals number of agent:message events", () => {
      const turnCounts = [1, 3, 5, 10];

      for (const turnCount of turnCounts) {
        const events = simulator.generateEvents({
          agentName: "test-agent",
          task: "Test task",
          outcome: "success",
          turnCount,
          toolsUsed: [],
          costUsd: 0.01,
          durationMs: 5000,
        });

        const episode = distiller.distill("test-agent", events);
        expect(episode.turnCount).toBe(turnCount);
      }
    });

    it("duration equals last event timestamp minus first event timestamp", () => {
      const durationMs = 10000;
      const events = simulator.generateEvents({
        agentName: "test-agent",
        task: "Test task",
        outcome: "success",
        turnCount: 3,
        toolsUsed: [],
        costUsd: 0.01,
        durationMs,
      });

      const episode = distiller.distill("test-agent", events);
      const expectedDuration = events[events.length - 1].timestamp - events[0].timestamp;
      expect(episode.durationMs).toBe(expectedDuration);
    });

    it("cost extracted from session:end payload", () => {
      const costUsd = 0.0523;
      const events = simulator.generateEvents({
        agentName: "test-agent",
        task: "Test task",
        outcome: "success",
        turnCount: 2,
        toolsUsed: [],
        costUsd,
        durationMs: 5000,
      });

      const episode = distiller.distill("test-agent", events);
      expect(episode.costUsd).toBe(costUsd);
    });

    it("tools used extracted from agent:tool_call events", () => {
      const toolsUsed = ["bash", "file_read", "grep"];
      const events = simulator.generateEvents({
        agentName: "test-agent",
        task: "Test task",
        outcome: "success",
        turnCount: 6,
        toolsUsed,
        costUsd: 0.01,
        durationMs: 5000,
      });

      const episode = distiller.distill("test-agent", events);
      for (const tool of toolsUsed) {
        expect(episode.toolsUsed).toContain(tool);
      }
    });
  });

  describe("Content Extraction", () => {
    it("extracts task description from session:start payload", () => {
      const task = "Analyze the codebase for security vulnerabilities";
      const events: AgentEvent[] = [
        {
          id: "e1",
          timestamp: Date.now(),
          sessionId: "s1",
          agentName: "test-agent",
          type: "session:start",
          payload: { task },
          traceId: "t1",
        },
        {
          id: "e2",
          timestamp: Date.now() + 1000,
          sessionId: "s1",
          agentName: "test-agent",
          type: "agent:completion",
          payload: {},
          traceId: "t1",
        },
        {
          id: "e3",
          timestamp: Date.now() + 2000,
          sessionId: "s1",
          agentName: "test-agent",
          type: "session:end",
          payload: { cost: 0.01 },
          traceId: "t1",
        },
      ];

      const episode = distiller.distill("test-agent", events);
      expect(episode.taskDescription).toBe(task);
    });

    it("generates lessons learned from error events", () => {
      const events = simulator.generateEvents({
        agentName: "test-agent",
        task: "Test task",
        outcome: "failure",
        turnCount: 3,
        toolsUsed: [],
        costUsd: 0.01,
        durationMs: 5000,
      });

      const episode = distiller.distill("test-agent", events);
      expect(episode.failurePatterns.length).toBeGreaterThan(0);
    });

    it("generates effective strategies for successful short sessions", () => {
      const events = simulator.generateEvents({
        agentName: "test-agent",
        task: "Test task",
        outcome: "success",
        turnCount: 2,
        toolsUsed: [],
        costUsd: 0.01,
        durationMs: 3000,
      });

      const episode = distiller.distill("test-agent", events);
      expect(episode.effectiveStrategies.length).toBeGreaterThan(0);
    });

    it("episode schema validation passes for all outcomes", () => {
      const outcomes: Array<"success" | "failure" | "partial"> = ["success", "failure", "partial"];

      for (const outcome of outcomes) {
        const events = simulator.generateEvents({
          agentName: "test-agent",
          task: "Schema validation test",
          outcome,
          turnCount: 2,
          toolsUsed: [],
          costUsd: 0.01,
          durationMs: 4000,
        });

        const episode = distiller.distill("test-agent", events);
        const validation = validator.validate(episode);
        expect(validation.valid).toBe(true);
        expect(validation.errors).toHaveLength(0);
      }
    });
  });
});
