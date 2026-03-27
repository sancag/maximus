import { AgentSimulator } from "./agent-simulator.js";
import type { SimulationConfig } from "./agent-simulator.js";
import type { AgentEvent } from "@maximus/shared";

export interface TestScenario {
  name: string;
  description: string;
  config: SimulationConfig;
  events: AgentEvent[];
}

/**
 * ScenarioGenerator provides predefined test scenarios for exercising
 * all memory system features (episode distillation, knowledge extraction, etc.)
 */
export class ScenarioGenerator {
  private simulator = new AgentSimulator();

  /**
   * Simple success: 2 turns, no tools, success outcome.
   */
  simpleSuccess(agentName = "test-agent"): TestScenario {
    const config: SimulationConfig = {
      agentName,
      task: "Answer a simple question",
      outcome: "success",
      turnCount: 2,
      toolsUsed: [],
      costUsd: 0.005,
      durationMs: 3000,
    };
    return {
      name: "simple-success",
      description: "Short successful session without tool usage",
      config,
      events: this.simulator.generateEvents(config),
    };
  }

  /**
   * Tool usage: 4 turns, bash tool, success outcome.
   */
  toolUsage(agentName = "test-agent"): TestScenario {
    const config: SimulationConfig = {
      agentName,
      task: "List files in directory using bash",
      outcome: "success",
      turnCount: 4,
      toolsUsed: ["bash"],
      costUsd: 0.01,
      durationMs: 8000,
    };
    return {
      name: "tool-usage",
      description: "Session with bash tool calls",
      config,
      events: this.simulator.generateEvents(config),
    };
  }

  /**
   * Error recovery: 3 turns, error event, failure outcome.
   */
  errorRecovery(agentName = "test-agent"): TestScenario {
    const config: SimulationConfig = {
      agentName,
      task: "Parse malformed JSON data",
      outcome: "failure",
      turnCount: 3,
      toolsUsed: [],
      costUsd: 0.008,
      durationMs: 6000,
    };
    return {
      name: "error-recovery",
      description: "Session that terminates with error",
      config,
      events: this.simulator.generateEvents(config),
    };
  }

  /**
   * Multi-turn: 10 turns, success outcome.
   */
  multiTurn(agentName = "test-agent"): TestScenario {
    const config: SimulationConfig = {
      agentName,
      task: "Refactor complex codebase with multiple files",
      outcome: "success",
      turnCount: 10,
      toolsUsed: ["bash", "file_read", "file_write"],
      costUsd: 0.05,
      durationMs: 30000,
    };
    return {
      name: "multi-turn",
      description: "Long multi-turn session with many tool calls",
      config,
      events: this.simulator.generateEvents(config),
    };
  }

  /**
   * Delegation: includes delegation event, partial outcome.
   */
  delegation(agentName = "test-agent", delegatedTo = "worker-agent"): TestScenario {
    const config: SimulationConfig = {
      agentName,
      task: "Coordinate file processing task",
      outcome: "partial",
      turnCount: 2,
      toolsUsed: [],
      costUsd: 0.003,
      durationMs: 5000,
      includeDelegation: true,
      delegatedTo,
    };
    return {
      name: "delegation",
      description: "Session that delegates work to another agent",
      config,
      events: this.simulator.generateEvents(config),
    };
  }

  /**
   * Multi-agent: generates events for 3 different agents.
   */
  multiAgent(): TestScenario[] {
    const agents = ["agent-a", "agent-b", "agent-c"];
    return agents.map((name, i) => {
      const config: SimulationConfig = {
        agentName: name,
        task: `Agent ${name} coordinated task`,
        outcome: i % 2 === 0 ? "success" : "failure",
        turnCount: 3 + i,
        toolsUsed: i === 0 ? ["bash"] : [],
        costUsd: 0.01 * (i + 1),
        durationMs: 5000 + i * 2000,
      };
      return {
        name: `multi-agent-${name}`,
        description: `Scenario for ${name}`,
        config,
        events: this.simulator.generateEvents(config),
      };
    });
  }

  /**
   * Get all predefined scenarios (single agent variants).
   */
  all(agentName = "test-agent"): TestScenario[] {
    return [
      this.simpleSuccess(agentName),
      this.toolUsage(agentName),
      this.errorRecovery(agentName),
      this.multiTurn(agentName),
      this.delegation(agentName),
    ];
  }

  /**
   * List all available scenario names.
   */
  listScenarios(): string[] {
    return ["simple-success", "tool-usage", "error-recovery", "multi-turn", "delegation"];
  }

  /**
   * Generate events for a named scenario.
   */
  generate(scenarioName: string, agentName = "test-agent"): AgentEvent[] {
    switch (scenarioName) {
      case "simple-success":
        return this.simpleSuccess(agentName).events;
      case "tool-usage":
        return this.toolUsage(agentName).events;
      case "error-recovery":
        return this.errorRecovery(agentName).events;
      case "multi-turn":
        return this.multiTurn(agentName).events;
      case "delegation":
        return this.delegation(agentName).events;
      default:
        throw new Error(`Unknown scenario: ${scenarioName}`);
    }
  }
}
