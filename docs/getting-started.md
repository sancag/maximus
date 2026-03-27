# Getting Started with Maximus

Step-by-step guide from installation to running your first agent team with the Mission Control dashboard.

## Prerequisites

- **Node.js 22+** (LTS recommended)
- **pnpm 10+** -- install globally with `npm install -g pnpm`
- **A Claude API key** from [console.anthropic.com](https://console.anthropic.com) or a Claude Agent SDK OAuth token

## Installation

```bash
git clone https://github.com/<owner>/maximus.git
cd maximus
pnpm install
pnpm build
```

The `pnpm install` step installs dependencies across all workspace packages. The `pnpm build` step compiles shared types, core engine, vault, and server via Turborepo.

## Project Structure

Maximus is a pnpm monorepo with five packages:

| Package | Path | Description |
|---|---|---|
| `@maximus/shared` | `packages/shared` | Shared TypeScript types and Zod schemas |
| `@maximus/core` | `packages/core` | Agent runtime, skill loader, credential vault integration |
| `@maximus/vault` | `packages/vault` | Credential encryption utilities (AES-256-GCM) |
| `@maximus/server` | `packages/server` | REST API + WebSocket server (Express 5) |
| `@maximus/dashboard` | `packages/dashboard` | Mission Control web UI (Next.js + React 19) |

## Step 1: Configure Credentials

Set the vault encryption key as an environment variable:

```bash
export MAXIMUS_VAULT_KEY="your-secret-key-here"
```

The vault encrypts all stored credentials at rest using AES-256-GCM. Agents never have direct access to secrets -- the tool executor resolves credentials from the vault at call time and sanitizes responses before returning them to the agent.

See [Credential Vault](./credential-vault.md) for full documentation on storing and managing secrets.

## Step 2: Define Your First Agent

Create a Markdown file for an orchestrator agent. Agent definitions use YAML frontmatter for metadata and Markdown body for the system prompt:

```markdown
---
name: orchestrator
description: Main orchestrator that coordinates the team
model: sonnet
maxTurns: 25
skills: []
---

You are the orchestrator. You manage a team of agents and delegate tasks
to the appropriate team members based on their skills and roles.

When given a goal, break it into subtasks and delegate each to the right agent.
Report results back to the user as they complete.
```

The `name` field is the unique identifier. The `model` field accepts `sonnet`, `opus`, or `haiku`. An agent without a `reportsTo` field is treated as the root orchestrator.

See [Agent Definition Format](./agent-definition.md) for the full schema and all available fields.

## Step 3: Define a Skill

Create a YAML skill file that bundles tools for your agents:

```yaml
name: example-skill
description: An example skill with a greeting tool
version: "1.0"
credentials: []
tools:
  - name: greet
    description: Greet someone by name
    parameters:
      - name: name
        type: string
        description: The name of the person to greet
        required: true
```

Skills define the tools available to agents. Each tool has a name, description, and typed parameter schema. Skills can also declare credential requirements that are resolved from the vault at runtime.

See [Skill Definition Format](./skill-definition.md) for the full schema, credential binding, and instructions field.

## Step 4: Start the Server

```bash
cd packages/server
pnpm start
```

The server starts on port 4100 and exposes:

| Endpoint | Description |
|---|---|
| `http://localhost:4100/api/health` | Health check |
| `http://localhost:4100/api/agents` | Agent management |
| `http://localhost:4100/api/tasks` | Task management |
| `http://localhost:4100/api/agents/org-chart` | Agent hierarchy |
| `ws://localhost:4100/ws` | WebSocket event stream |

The server uses Express 5 with a single-port HTTP+WebSocket setup via noServer WebSocket upgrade.

## Step 5: Start the Dashboard

In a separate terminal:

```bash
cd packages/dashboard
pnpm dev
```

The dashboard starts on port 4200 with Turbopack for fast development. Open [http://localhost:4200](http://localhost:4200) in your browser.

For production:

```bash
pnpm build
pnpm start  # Also starts on port 4200
```

## Step 6: Using the Dashboard

Once both server and dashboard are running:

1. **Open** [http://localhost:4200](http://localhost:4200) -- you land on the **Operations** view (activity feed)
2. **Check the header** -- a green dot in the top-right means the dashboard is connected to the server via WebSocket
3. **Click the Chat icon** (speech bubble) in the sidebar to open the Chat view
4. **Type a message** to your orchestrator agent and press Enter -- the response streams in real-time via SSE
5. **Watch the Operations view** for real-time events as agents process work (tool calls, delegations, completions)
6. **Click the Org Chart icon** (network) to see your agent hierarchy as a top-down tree
7. **Click the Tasks icon** (checklist) to track all task progress with sortable columns and status filters

See [Dashboard Documentation](./dashboard.md) for detailed view descriptions, event type mappings, and connection handling.

## Multi-Agent Setup

To set up a hierarchy, define multiple agents with `reportsTo` fields:

**Orchestrator** (root -- no `reportsTo`):
```markdown
---
name: orchestrator
description: Coordinates the team
model: sonnet
---
```

**Manager** (reports to orchestrator):
```markdown
---
name: research-manager
description: Manages research tasks
model: sonnet
reportsTo: orchestrator
---
```

**Worker** (reports to manager):
```markdown
---
name: web-researcher
description: Searches the web for information
model: haiku
reportsTo: research-manager
skills:
  - web-search
---
```

Delegation is code-enforced: agents can only delegate to their direct reports, and the runtime validates hierarchy before spawning child work.

See [Multi-Agent Coordination](./multi-agent.md) for delegation patterns, task lifecycle, safety mechanisms, and the full API reference.

## Troubleshooting

| Problem | Solution |
|---|---|
| Dashboard shows "Reconnecting to server..." | Ensure the server is running on port 4100. The dashboard auto-reconnects with exponential backoff. |
| No agents appear in Org Chart | Ensure agent definition files are loaded by the server and registered via the API. |
| Build errors | Run `pnpm install && pnpm build` from the repository root to rebuild all packages. |
| WebSocket not connecting | Check that `NEXT_PUBLIC_WS_URL` is set correctly (default: `ws://localhost:4100/ws`). |
| Chat messages not streaming | Verify the server's `/api/chat` endpoint is reachable and the orchestrator agent is registered. |
| Port conflicts | The server defaults to 4100 and dashboard to 4200. Set `PORT` for the server or update `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` to match. |

## Memory System

Maximus agents can accumulate structured memory from their sessions. The memory system uses a dual database: Kuzu graph database for knowledge relationships and SQLite for episodes and metrics.

### Enabling Agent Memory

Add a `memory:` block to any agent's frontmatter:

```yaml
---
name: researcher
description: Research specialist
model: sonnet
memory:
  episodic: true
  maxEpisodes: 50
  knowledgeScopes: []
  briefingEnabled: true
  briefingTokenBudget: 2000
  learningRate: moderate
---
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| episodic | boolean | true | Capture episodes from sessions |
| maxEpisodes | number | 50 | Max episodes to retain per agent |
| knowledgeScopes | string[] | [] | Additional scopes to query |
| briefingEnabled | boolean | true | Inject briefings before sessions |
| briefingTokenBudget | number | 2000 | Max chars for briefing content |
| learningRate | string | moderate | conservative, moderate, or aggressive |

### Deep Sleep Consolidation

The deep sleep pipeline runs on a cron schedule (default: 3 AM daily) and performs:
1. Trace analysis and episode distillation
2. Entity extraction into the knowledge graph
3. Briefing generation for each agent
4. Stale knowledge pruning
5. Scope promotion of high-value facts

Set the schedule with the `MAXIMUS_DEEP_SLEEP_SCHEDULE` environment variable (cron syntax).

### Performance Trends

Agents with memory enabled automatically receive performance trends in their session briefings. These trends show success rate direction (UP/DOWN/STABLE), cost patterns, and failure concentration over a 7-day sliding window. No configuration is needed -- if `briefingEnabled: true`, trends are included.

### CLI Memory Commands

```bash
# Show overall memory system status
maximus memory status

# Inspect a specific agent's memory
maximus memory inspect <agent-name>

# Manually promote a knowledge triple to a higher scope
maximus memory promote <sourceId> <predicate> <targetId>

# Re-extract entities from all processed episodes with the current extraction prompt
# Useful after extraction improvements to reprocess historical data
maximus memory re-extract

# Reset memory databases (episodes, knowledge graph, briefings) for a clean slate
maximus memory reset
```

The `maxToolResultChars` option in agent memory config controls how much of each tool result is captured in traces. Higher values provide richer extraction data at the cost of more storage.

### Knowledge Scopes

Knowledge is organized in three scope levels:
- **Agent**: Private to one agent
- **Team**: Shared among agents with the same `reportsTo`
- **Global**: Available to all agents

Facts are automatically promoted up the scope hierarchy during deep sleep based on retrieval frequency and cross-agent relevance.

## Next Steps

- [Dashboard Documentation](./dashboard.md) -- detailed view descriptions, event types, and connection handling
- [Agent Definition Format](./agent-definition.md) -- full agent configuration schema and options
- [Skill Definition Format](./skill-definition.md) -- tool definitions, parameters, and credential binding
- [Credential Vault](./credential-vault.md) -- encrypting and managing secrets
- [Multi-Agent Coordination](./multi-agent.md) -- hierarchies, delegation, task lifecycle, and observability
- [Knowledge Graph & Agent Memory](./knowledge-graph.md) -- entities, scope hierarchy, briefings, and deep sleep consolidation
