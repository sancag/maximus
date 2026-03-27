import type { AgentEvent } from "@maximus/shared";
import { nanoid } from "nanoid";

export interface SimulationConfig {
  agentName: string;
  task: string;
  outcome: "success" | "failure" | "partial";
  turnCount: number;
  toolsUsed: string[];
  costUsd: number;
  durationMs: number;
  includeDelegation?: boolean;
  delegatedTo?: string;
}

export class AgentSimulator {
  generateEvents(config: SimulationConfig): AgentEvent[] {
    const sessionId = nanoid();
    const traceId = nanoid();
    const now = Date.now();
    const events: AgentEvent[] = [];

    // session:start
    events.push({
      id: nanoid(),
      timestamp: now,
      sessionId,
      agentName: config.agentName,
      type: "session:start",
      payload: { task: config.task },
      traceId,
    });

    // Generate message turns
    for (let i = 0; i < config.turnCount; i++) {
      events.push({
        id: nanoid(),
        timestamp: now + (i + 1) * (config.durationMs / (config.turnCount + 2)),
        sessionId,
        agentName: config.agentName,
        type: "agent:message",
        payload: { role: i % 2 === 0 ? "assistant" : "user", content: `Message ${i}` },
        traceId,
      });

      // Tool calls
      if (config.toolsUsed.length > 0 && i % 2 === 0) {
        const tool = config.toolsUsed[i % config.toolsUsed.length];
        events.push({
          id: nanoid(),
          timestamp: now + (i + 1) * (config.durationMs / (config.turnCount + 2)) + 50,
          sessionId,
          agentName: config.agentName,
          type: "agent:tool_call",
          payload: { tool, args: {} },
          traceId,
        });
        events.push({
          id: nanoid(),
          timestamp: now + (i + 1) * (config.durationMs / (config.turnCount + 2)) + 100,
          sessionId,
          agentName: config.agentName,
          type: "agent:tool_result",
          payload: { tool, result: "ok" },
          traceId,
        });
      }
    }

    // Delegation events
    if (config.includeDelegation && config.delegatedTo) {
      events.push({
        id: nanoid(),
        timestamp: now + config.durationMs - 2000,
        sessionId,
        agentName: config.agentName,
        type: "agent:delegation",
        payload: { to: config.delegatedTo, task: config.task },
        traceId,
      });
    }

    // Outcome event
    if (config.outcome === "success") {
      events.push({
        id: nanoid(),
        timestamp: now + config.durationMs - 1000,
        sessionId,
        agentName: config.agentName,
        type: "agent:completion",
        payload: { result: "completed" },
        traceId,
      });
    } else if (config.outcome === "failure") {
      events.push({
        id: nanoid(),
        timestamp: now + config.durationMs - 1000,
        sessionId,
        agentName: config.agentName,
        type: "agent:error",
        payload: { error: "Something broke" },
        traceId,
      });
    }

    // session:end
    events.push({
      id: nanoid(),
      timestamp: now + config.durationMs,
      sessionId,
      agentName: config.agentName,
      type: "session:end",
      payload: { cost: config.costUsd },
      traceId,
    });

    return events;
  }
}
