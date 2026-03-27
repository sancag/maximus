# Multi-Agent Coordination

Maximus supports hierarchical agent coordination where work flows down the org chart and results flow up, with full observability. An orchestrator delegates to managers, managers delegate to workers, and every action is traceable in real-time via REST API and WebSocket event streaming.

This document covers hierarchy setup, delegation patterns, task lifecycle, safety mechanisms, observability, and API reference.

## Hierarchy Setup

Agent hierarchy is defined using the `reportsTo` field in each agent's Markdown frontmatter. An agent without `reportsTo` is a root (typically the orchestrator). Agents with `reportsTo` are children that can only receive delegated work from their parent.

Delegation is **code-enforced, not agent-decided** -- the runtime validates hierarchy before spawning any child work. An agent cannot self-route or delegate to arbitrary agents.

### Example Hierarchy

Three agent definition files establishing an orchestrator -> manager -> worker chain:

**`agents/orchestrator.md`**

```markdown
---
name: orchestrator
description: Top-level coordinator that breaks work into streams
model: opus
maxTurns: 50
---

You coordinate complex projects by breaking them into work streams
and delegating to specialized managers. You synthesize results from
managers into cohesive deliverables.
```

**`agents/research-manager.md`**

```markdown
---
name: research-manager
description: Manages research tasks and coordinates research workers
model: sonnet
maxTurns: 30
reportsTo: orchestrator
skills:
  - github-operations
---

You manage research workflows. When given a research objective,
break it into focused tasks and delegate to research workers.
Aggregate findings into structured reports.
```

**`agents/research-worker.md`**

```markdown
---
name: research-worker
description: Executes focused research tasks
model: haiku
maxTurns: 20
reportsTo: research-manager
skills:
  - github-operations
---

You execute focused research tasks. Gather information, analyze it,
and return structured findings to your manager.
```

This produces the hierarchy:

```
orchestrator          (root -- no reportsTo)
  |
  +-- research-manager  (reportsTo: orchestrator)
        |
        +-- research-worker  (reportsTo: research-manager)
```

The `AgentRegistry.canDelegateTo(from, to)` method validates that the target agent's `reportsTo` matches the delegating agent's name. See `packages/core/src/agents/registry.ts`.

## Delegation Patterns

Maximus provides two coordination primitives:

| Primitive | Direction | Validation |
|-----------|-----------|------------|
| **Delegate** | Parent to child (hierarchical) | Target's `reportsTo` must match sender |
| **Message** | Peer to peer (same level) | Both agents must share the same `reportsTo` |

### How Delegation Works

The `Delegator` class (`packages/core/src/delegation/delegator.ts`) executes this sequence:

1. **Validate hierarchy** -- confirms `registry.canDelegateTo(from, to)` returns true
2. **Check circuit breakers** -- ensures chain depth and concurrent task limits are not exceeded
3. **Check token budget** -- if `budgetCeiling` is set, verifies the trace has not exceeded it
4. **Create task** -- creates a `Task` record in the `TaskStore` with status `created`
5. **Transition to assigned** -- task status moves to `assigned`
6. **Acquire agent lock** -- prevents concurrent sessions on the same agent
7. **Transition to in-progress** -- task status moves to `in-progress`, agent session starts
8. **Run child session** -- calls `engine.runAgent()` which starts a Claude SDK session
9. **Record usage and complete** -- on success, records token usage and transitions task to `completed`
10. **Handle failure** -- on error, transitions task to `failed`, propagates error to parent

### Fan-Out

A manager can delegate to multiple workers in parallel:

```typescript
const results = await Promise.all([
  delegator.delegate({
    fromAgent: "research-manager",
    toAgent: "worker-1",
    prompt: "Research topic A",
    traceId,
  }),
  delegator.delegate({
    fromAgent: "research-manager",
    toAgent: "worker-2",
    prompt: "Research topic B",
    traceId,
  }),
]);
```

Each delegation creates its own task, acquires its own lock, and runs independently. The `maxConcurrent` circuit breaker limits how many can run simultaneously within a trace.

### Context Passing

Context is passed as a structured message (prompt + relevant prior output), not raw conversation history. The parent agent decides what context is relevant:

```typescript
const result = await delegator.delegate({
  fromAgent: "orchestrator",
  toAgent: "research-manager",
  prompt: `Analyze the quarterly report. Here is the summary from finance:

  ${financeResult.output}`,
  traceId,
});
```

### Results Flow Back

The parent receives the child's `SessionResult.output`. The parent can then act on it, delegate further, or return it up the chain.

### Error Handling

On failure, the task is marked `failed` with the error message. The error propagates to the parent agent who can decide to retry, escalate, or abort. Error types include:

- `HierarchyViolationError` -- delegation target does not report to sender
- `CircuitBreakerError` -- chain depth or concurrent task limit exceeded
- `BudgetExceededError` -- token budget ceiling reached

### Code Example

```typescript
import { AgentEngine } from "@maximus/core";
import { nanoid } from "nanoid";

// Initialize engine (loads agents from agents/ directory)
const engine = new AgentEngine(config);
await engine.initialize();

// Get the delegator
const delegator = engine.getDelegator();

// Delegate work from orchestrator to manager
const result = await delegator.delegate({
  fromAgent: "orchestrator",
  toAgent: "research-manager",
  prompt: "Analyze the quarterly report and summarize key findings",
  traceId: nanoid(),
});

console.log(result.output); // Manager's synthesized response
```

## Task Lifecycle

Every delegation creates a first-class `Task` entity that tracks the full lifecycle of that unit of work.

### States

```
              +----------+
              | created  |
              +----+-----+
                   |
              +----v-----+
              | assigned  |
              +----+-----+
                   |
           +------v-------+
           | in-progress   |
           +---+-------+---+
               |       |
        +------v--+ +--v------+
        |completed| | failed  |
        +---------+ +---------+
```

Transitions are strictly enforced. The only valid paths are:

- `created` -> `assigned`
- `assigned` -> `in-progress`
- `in-progress` -> `completed`
- `in-progress` -> `failed`

No skipping states. See `packages/core/src/tasks/lifecycle.ts` for the `VALID_TRANSITIONS` map.

### Task Fields

Each task tracks these fields (defined in `packages/shared/src/tasks.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique task ID (nanoid) |
| `parentTaskId` | string? | ID of the parent task (for delegation chains) |
| `agentName` | string | Name of the agent assigned to this task |
| `status` | TaskStatus | Current lifecycle state |
| `prompt` | string | The work instruction |
| `result` | string? | Output on completion |
| `error` | string? | Error message on failure |
| `traceId` | string | Trace ID linking all tasks in a delegation chain |
| `tokenUsage` | number | Token cost recorded for this task |
| `createdAt` | number | Timestamp of creation |
| `updatedAt` | number | Timestamp of last update |
| `completedAt` | number? | Timestamp of completion or failure |

### TaskStore API

The `TaskStore` class (`packages/core/src/tasks/store.ts`) provides:

| Method | Description |
|--------|-------------|
| `create(params)` | Create a new task with status `created` |
| `get(id)` | Get a task by ID (throws if not found) |
| `transition(id, status, update?)` | Transition task to new status with optional field updates |
| `getByTraceId(traceId)` | Get all tasks in a delegation chain |
| `getChainDepth(traceId)` | Compute max delegation depth by walking `parentTaskId` links |
| `getActiveConcurrentCount(traceId)` | Count tasks with `in-progress` or `assigned` status |
| `getAll()` | Get all tasks |

Tasks are stored in-memory for v1. They are queryable via the REST API while the server is running.

## Safety: Budgets and Circuit Breakers

### Token Budgets

Token budgets are configurable per delegation chain via the `budgetCeiling` field on `DelegationRequest`. The `BudgetTracker` (`packages/core/src/tasks/budget.ts`) accumulates usage per `traceId` and blocks delegation when the ceiling is reached.

```typescript
await delegator.delegate({
  fromAgent: "orchestrator",
  toAgent: "research-manager",
  prompt: "...",
  traceId,
  budgetCeiling: 100000, // Max tokens for this entire chain
});
```

If the chain's accumulated usage reaches or exceeds the ceiling, `BudgetExceededError` is thrown.

### Circuit Breakers

Two circuit breakers prevent runaway delegation:

| Breaker | Default | Description |
|---------|---------|-------------|
| `maxDepth` | 5 | Maximum delegation chain depth (orchestrator -> manager -> worker = depth 2) |
| `maxConcurrent` | 10 | Maximum concurrent active tasks within a trace |

When either limit is reached, `CircuitBreakerError` is thrown with the reason (`max_depth` or `max_concurrent`) and the current value.

### Agent Write Lock

A per-agent write lock (`AgentLock`) prevents concurrent sessions targeting the same agent. The lock is acquired before `runAgent()` and released in a `finally` block, ensuring cleanup even on failure.

### Error Types

```typescript
import {
  HierarchyViolationError,
  CircuitBreakerError,
  BudgetExceededError,
} from "@maximus/core";

try {
  await delegator.delegate(request);
} catch (error) {
  if (error instanceof HierarchyViolationError) {
    // fromAgent cannot delegate to toAgent
  } else if (error instanceof CircuitBreakerError) {
    // error.reason: "max_depth" | "max_concurrent"
    // error.value: current depth or concurrent count
  } else if (error instanceof BudgetExceededError) {
    // error.used: tokens used so far
    // error.ceiling: configured ceiling
  }
}
```

## Observability

### Trace IDs

A trace ID is generated at the root of a delegation chain and propagated to all child tasks and sessions. Every task and event within the chain shares the same `traceId`, enabling end-to-end tracing.

```typescript
const traceId = nanoid(); // Generated once at root
await delegator.delegate({ fromAgent: "orchestrator", toAgent: "manager", prompt: "...", traceId });
// All child tasks and events carry this traceId
```

### Event Types

Every `AgentEvent` (defined in `packages/shared/src/events.ts`) carries `traceId` and `parentSessionId` fields:

```typescript
interface AgentEvent {
  id: string;
  timestamp: number;
  sessionId: string;
  agentName: string;
  type: AgentEventType;
  payload: Record<string, unknown>;
  traceId?: string;
  parentSessionId?: string;
}
```

Task lifecycle events emitted by the `Delegator`:

| Event | When |
|-------|------|
| `task:created` | Task created in store |
| `task:assigned` | Task assigned to agent |
| `task:completed` | Agent finished successfully |
| `task:failed` | Agent encountered an error |

Agent session events:

| Event | When |
|-------|------|
| `session:start` | Agent session begins |
| `session:end` | Agent session ends |
| `agent:message` | Agent produces a text message |
| `agent:tool_call` | Agent calls a tool |
| `agent:tool_result` | Tool returns a result |
| `agent:delegation` | Agent delegates to a child |
| `agent:completion` | Agent completes its turn |
| `agent:error` | Agent encounters an error |

### Structured Logging

All events flow through the `EventBus` (`packages/core/src/events/bus.ts`). The server uses pino for structured logging with trace context attached to log lines for correlation.

## REST API

The server exposes a REST API for querying tasks, agents, and system health. All endpoints return JSON.

### Health Check

```bash
curl http://localhost:3000/api/health
```

Response:

```json
{ "status": "ok", "timestamp": 1710936000000 }
```

### List Tasks

```bash
# All tasks
curl http://localhost:3000/api/tasks

# Filter by trace ID
curl "http://localhost:3000/api/tasks?traceId=abc123"

# Filter by agent name
curl "http://localhost:3000/api/tasks?agentName=research-manager"

# Filter by status
curl "http://localhost:3000/api/tasks?status=completed"

# Combine filters
curl "http://localhost:3000/api/tasks?traceId=abc123&status=in-progress"
```

Response:

```json
{
  "tasks": [
    {
      "id": "task_abc",
      "parentTaskId": null,
      "agentName": "research-manager",
      "status": "completed",
      "prompt": "Analyze the quarterly report",
      "result": "Key findings: ...",
      "traceId": "abc123",
      "tokenUsage": 1500,
      "createdAt": 1710936000000,
      "updatedAt": 1710936005000,
      "completedAt": 1710936005000
    }
  ]
}
```

### Get Task by ID

```bash
curl http://localhost:3000/api/tasks/task_abc
```

Response:

```json
{
  "task": {
    "id": "task_abc",
    "agentName": "research-manager",
    "status": "completed",
    "prompt": "Analyze the quarterly report",
    "result": "Key findings: ...",
    "traceId": "abc123",
    "tokenUsage": 1500,
    "createdAt": 1710936000000,
    "updatedAt": 1710936005000,
    "completedAt": 1710936005000
  }
}
```

Returns `404` if the task does not exist.

### List Agents

```bash
curl http://localhost:3000/api/agents
```

Response:

```json
{
  "agents": [
    {
      "name": "orchestrator",
      "description": "Top-level coordinator",
      "model": "opus",
      "skills": []
    },
    {
      "name": "research-manager",
      "description": "Manages research tasks",
      "model": "sonnet",
      "reportsTo": "orchestrator",
      "skills": ["github-operations"]
    }
  ]
}
```

### Get Org Chart

```bash
curl http://localhost:3000/api/agents/org-chart
```

Response:

```json
{
  "agents": [
    { "name": "orchestrator", "description": "Top-level coordinator" },
    { "name": "research-manager", "reportsTo": "orchestrator", "description": "Manages research tasks" },
    { "name": "research-worker", "reportsTo": "research-manager", "description": "Executes research tasks" }
  ]
}
```

## WebSocket Event Streaming

The server provides real-time event streaming over WebSocket. All `EventBus` events are broadcast to connected clients via the `EventBridge` (`packages/server/src/ws/bridge.ts`).

### Connecting

```bash
# Using wscat
wscat -c ws://localhost:3000/ws
```

The WebSocket endpoint is at `/ws` on the same port as the HTTP server (single-port architecture using `noServer` WebSocket upgrade).

### Frame Format

All messages are JSON frames with the `WebSocketFrame` structure (`packages/server/src/ws/frames.ts`):

```typescript
interface WebSocketFrame {
  type: "event" | "connected" | "error";
  event?: string;       // Event type (for "event" frames)
  payload: Record<string, unknown>;
  seq: number;          // Sequential frame number
}
```

### Welcome Frame

On connection, clients receive a welcome frame:

```json
{
  "type": "connected",
  "payload": { "message": "Connected to Maximus event stream" },
  "seq": 0
}
```

### Event Frames

Task and agent events are delivered as frames with sequential numbering:

```json
{
  "type": "event",
  "event": "task:created",
  "payload": {
    "id": "evt_abc",
    "timestamp": 1710936000000,
    "sessionId": "",
    "agentName": "research-manager",
    "type": "task:created",
    "payload": { "taskId": "task_abc", "parentTaskId": null },
    "traceId": "abc123"
  },
  "seq": 1
}
```

### Sequential Numbering

The `seq` field increments globally across all frames. Clients can detect dropped frames by checking for gaps in the sequence. A gap indicates frames were skipped (due to backpressure or disconnection).

### Backpressure Handling

If a client's send buffer exceeds 64KB (`BACKPRESSURE_THRESHOLD`), frames are skipped for that client to prevent memory buildup. Slow clients may miss events -- use the REST API to query tasks for the authoritative state.

### Client-Side Filtering

The server broadcasts all events to all connected clients. Filter on the client side by inspecting the `payload` fields:

```javascript
const ws = new WebSocket("ws://localhost:3000/ws");

ws.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  if (frame.type !== "event") return;

  // Filter by trace ID
  if (frame.payload.traceId === "abc123") {
    console.log(`[${frame.event}]`, frame.payload);
  }

  // Filter by agent name
  if (frame.payload.agentName === "research-manager") {
    console.log(`[${frame.event}]`, frame.payload);
  }
};
```

## Quick Start Example

A complete example: define 3 agents, start the server, delegate work, and observe via API and WebSocket.

### 1. Define Agents

Create the agent files shown in [Hierarchy Setup](#hierarchy-setup) above:

- `agents/orchestrator.md` -- root coordinator
- `agents/research-manager.md` -- manages research workers, `reportsTo: orchestrator`
- `agents/research-worker.md` -- executes tasks, `reportsTo: research-manager`

### 2. Start the Server

```typescript
import { AgentEngine } from "@maximus/core";
import { createApp } from "@maximus/server";

const engine = new AgentEngine({
  agentsDir: "./agents",
  skillsDir: "./skills",
});
await engine.initialize();

const { server } = createApp(engine);
server.listen(3000, () => {
  console.log("Maximus running on http://localhost:3000");
});
```

### 3. Delegate Work

```typescript
import { nanoid } from "nanoid";

const delegator = engine.getDelegator();
const traceId = nanoid();

const result = await delegator.delegate({
  fromAgent: "orchestrator",
  toAgent: "research-manager",
  prompt: "Research the top 3 competitors and summarize their strengths",
  traceId,
});

console.log("Result:", result.output);
```

### 4. Query via REST API

```bash
# Check all tasks in the delegation chain
curl "http://localhost:3000/api/tasks?traceId=${TRACE_ID}"

# View the org chart
curl http://localhost:3000/api/agents/org-chart

# Check system health
curl http://localhost:3000/api/health
```

### 5. Observe via WebSocket

```bash
# Stream events in real-time
wscat -c ws://localhost:3000/ws
```

You will see frames for `task:created`, `task:assigned`, `session:start`, `agent:message`, `task:completed`, and more -- all carrying the `traceId` for correlation.

## Related Documentation

- [Agent Definition Format](./agent-definition.md) -- how to write agent Markdown files
- [Skill Definition Format](./skill-definition.md) -- how to define tools for agents
- [Credential Vault](./credential-vault.md) -- secure credential management
