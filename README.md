<p align="center">
  <img src="packages/dashboard/src/app/favicon.svg" width="80" height="80" alt="Maximus Logo">
</p>

<h1 align="center">Maximus</h1>

<p align="center">
  <strong>Self-hosted agent orchestration platform built on the Claude Agent SDK</strong>
</p>

<p align="center">
  Define hierarchical teams of Claude agents that delegate, coordinate, and accumulate<br>
  structured knowledge across sessions — with encrypted credentials and real-time observability.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="docs/index.html">Full Documentation</a> &middot;
  <a href="docs/knowledge-graph.html">Knowledge Graph</a>
</p>

---

## What is Maximus?

Maximus lets you define teams of Claude agents that collaborate like a company org chart — an orchestrator delegates to managers, managers delegate to workers, and every tool call, delegation, and result is tracked through a real-time event stream.

The system solves three problems that arise when you run multiple agents against real-world tasks:

**Credential security.** Agents need API keys to call external services, but you don't want raw secrets in context windows. Maximus encrypts all credentials with AES-256-GCM and injects them at tool execution time through a proxy pattern — the agent never sees a token, only the result. A PostToolUse sanitizer catches any secrets that leak into tool outputs before they reach the agent.

**Cross-session memory.** Without memory, an agent that spent two sessions learning how to reliably paginate a particular API will rediscover the same lesson in session three, and four, and five. The knowledge graph solves this at the swarm level — a dual-database engine (Kuzu graph + SQLite) records session experiences, consolidates them into queryable knowledge overnight, and injects relevant facts back into each agent's system prompt before the next session.

**Observability.** When a delegation chain is five levels deep and something goes wrong at level four, you need to see what happened. Every event is logged to JSONL traces, broadcast over WebSocket, and visualized in the Mission Control dashboard with 15 event types, each with distinct colors and icons.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  User Layer                                                  │
│  CLI (Ink/React TUI)  │  Dashboard (Next.js 16)  │  REST API │
├─────────────────────────────────────────────────────────────┤
│  Platform Layer                                              │
│  Server (Express 5)  │  Core Engine  │  Memory  │  Vault     │
│  + Job Scheduler     │  + Delegator  │  + Deep  │  + Proxy   │
│                      │  + AgentLock  │    Sleep │  + Sanitize │
├─────────────────────────────────────────────────────────────┤
│  Storage Layer                                               │
│  Kuzu (Knowledge Graph)  │  SQLite (Episodes)  │  JSONL      │
│                          │                     │  (Traces)   │
└─────────────────────────────────────────────────────────────┘
```

Seven packages in a pnpm monorepo:

| Package | Path | Purpose |
|---------|------|---------|
| `@maximus/shared` | `packages/shared` | Shared TypeScript types and Zod schemas |
| `@maximus/vault` | `packages/vault` | AES-256-GCM encryption, CredentialProxy, output sanitizer |
| `@maximus/core` | `packages/core` | Agent runtime, skill loader, delegation engine, event bus, task store |
| `@maximus/memory` | `packages/memory` | Dual-database engine, deep sleep pipeline, briefing generator |
| `@maximus/server` | `packages/server` | Express 5 REST API, WebSocket event bridge, job scheduler |
| `@maximus/dashboard` | `packages/dashboard` | Next.js 16 + React 19 Mission Control UI (7 views) |
| `@maximus/cli` | `packages/cli` | Interactive TUI (Ink + React), init wizard, command-line interface |

## Quick Start

### Prerequisites

- **Node.js 22+** (LTS recommended)
- **pnpm 10+** — `npm install -g pnpm`
- **Claude API key** from [console.anthropic.com](https://console.anthropic.com)

### Install & Initialize

```bash
git clone https://github.com/chrisgscott/maximus.git
cd maximus
pnpm install && pnpm build

# Interactive wizard — creates ~/.maximus/ with full project structure
maximus init
```

The `init` wizard prompts for three things:

1. **Agent name** (default: "maximus") — your root orchestrator
2. **OAuth token** — Claude API credential (or set `CLAUDE_CODE_OAUTH_TOKEN` env var)
3. **Vault encryption key** — password for AES-256-GCM credential encryption

It creates the complete project structure:

```
~/.maximus/
├── config.json                 # Project config (name, port: 4100)
├── identity.md                 # Orchestrator identity document
├── .env                        # CLAUDE_CODE_OAUTH_TOKEN, MAXIMUS_VAULT_KEY
├── agents/
│   ├── {name}.md              # Your orchestrator agent
│   └── memory-extractor.md    # Required Haiku agent for entity extraction
├── skills/                     # Skill definitions (YAML)
├── vault/                      # Encrypted credential storage
├── memory/                     # Kuzu + SQLite databases
├── traces/                     # JSONL session traces
└── docs/                       # Reference docs
```

### Run

```bash
# Start the server (background mode, port 4100)
maximus server start

# Start the dashboard (port 4200)
cd packages/dashboard && pnpm dev

# Or just chat from the terminal
maximus chat "What can you do?"

# Or launch the interactive TUI
maximus
```

## Agent Definitions

Agents are Markdown files in `agents/` with YAML frontmatter for metadata and a Markdown body for the system prompt. The `AgentLoader` parses frontmatter with `gray-matter` and validates it against a Zod schema. The `AgentRegistry` holds all loaded agents in memory and supports hot-reload.

```yaml
---
name: research-manager
description: Manages research tasks and delegates to specialists
model: sonnet              # sonnet | opus | haiku
maxTurns: 30               # Max tool-use turns per session
reportsTo: orchestrator    # Parent agent (omit for root)
skills:
  - web-search
  - document-analysis
memory:
  episodic: true
  maxEpisodes: 50
  briefingEnabled: true
  briefingTokenBudget: 2000
  learningRate: moderate   # conservative | moderate | aggressive
---

You are the research manager. When given a research goal,
break it into focused subtasks and delegate to your team.
```

Agents without a `reportsTo` field are root orchestrators. The `init` wizard also creates a `memory-extractor.md` agent — a Haiku-powered agent used internally by the deep sleep pipeline for entity extraction. Without it, entity extraction is skipped and `maximus doctor` will warn.

## Skill Definitions

Skills are YAML files in `skills/` that bundle tools for agents. Each tool has a name, typed parameters, and an HTTP action. Credentials are declared as references to vault entries and injected via `{{VARIABLE}}` template substitution at execution time.

```yaml
name: github-operations
description: GitHub issue and PR management
version: "1.0"

credentials:
  - name: github_token           # Must exist in vault
    description: GitHub PAT

tools:
  - name: create_issue
    description: Create a GitHub issue
    parameters:
      repo: { type: string, description: "owner/repo" }
      title: { type: string }
    credentials:
      - ref: github_token        # Vault credential name
        inject_as: GITHUB_TOKEN  # Template variable name
    action:
      type: http
      method: POST
      url: "https://api.github.com/repos/{{repo}}/issues"
      headers:
        Authorization: "Bearer {{GITHUB_TOKEN}}"
      body:
        title: "{{title}}"
```

The `composeSkillToMcpServer` function transforms each skill into an MCP server. At tool execution time, the `CredentialProxy` decrypts vault entries, the `interpolateTemplate` engine substitutes variables, and the HTTP request is made — all outside the agent's context.

## Credential Vault

The vault uses **AES-256-GCM** authenticated encryption. The key is derived from `MAXIMUS_VAULT_KEY` via **scrypt** (32-byte salt). Each credential gets a unique 16-byte IV from `crypto.randomBytes`. GCM's authentication tag detects tampering.

### The Credential Proxy Pattern

The agent never touches credentials. Here's the data flow:

1. **Encrypted vault file** — each credential stored as `{iv, data, tag}` hex
2. **CredentialProxy.resolve()** — decrypts at tool execution time, maps vault names to template variables via `inject_as`
3. **Template interpolation** — merges agent-provided params (`repo: "maximus"`) with resolved creds (`TOKEN: "ghp_..."`)
4. **Output sanitization** — PostToolUse hook pattern-matches tool results before the agent sees them. Catches: `sk-ant-*` (Anthropic), `ghp_*` (GitHub), `AKIA*` (AWS), Bearer tokens, connection strings, authorization headers, and generic long hex strings. All replaced with `[REDACTED]`.

**Security guarantees:** No vault API exposed to agents. Credentials never in context window — agents see `{{TOKEN}}`, not values. Interpolation happens at execution boundary, after tracing. Authenticated encryption detects tampered vault files.

## Delegation Engine

When a parent agent needs work done, it calls the `delegate` tool — an MCP server injected into every session. Delegation is **non-blocking**: the parent gets a `taskId` immediately and continues working. Later, `check_task` polls for results or `wait_for_tasks` awaits multiple in parallel.

Three circuit breakers prevent runaway behavior:

| Breaker | Limit | Prevents |
|---------|-------|----------|
| **Hierarchy** | `target.reportsTo === sender` | Cross-hierarchy delegation |
| **Depth** | 5 hops max | Infinite delegation loops |
| **Token Budget** | Configurable ceiling | Runaway API costs |

**Task lifecycle:** `created → assigned → in-progress → completed | failed`. Each transition emits an event. The **AgentLock** serializes execution per agent name — one run at a time per agent, with queue for subsequent requests.

## Memory System

The memory system uses a dual-database architecture to give agents persistent knowledge across sessions.

### How It Works

1. **During sessions** — the runtime writes JSONL trace files (every tool call, result, message, outcome). Nothing is processed yet.
2. **During deep sleep** (default 3 AM daily) — the consolidation pipeline runs:
   - **EpisodeDistiller** — parses traces into structured episodes: summary, outcome, lessons, effective strategies, failure patterns. Detects regressions (task that previously succeeded but now fails). No LLM involved.
   - **EntityExtractor** — sends episodes to Claude Haiku in parallel. Returns typed entities and relationship triples with confidence scores (0.9 for confirmed facts, 0.7 for patterns, 0.5 for inferences). Entities deduplicated by name, attributes merged.
   - **ScopePromoter** — auto-promotes knowledge up the hierarchy. Agent→Team when 2+ teammates share the same fact or retrieval count exceeds threshold (adjusted by success rate). Team→Global when 2+ teams share. Orchestrator knowledge auto-promoted.
   - **BriefingGenerator** — assembles prioritized markdown briefing within token budget. Priority: failure lessons first, then performance trends (7-day window), then high-confidence graph facts, then proven strategies (usage count ≥2).
   - **Pruning** — stale triples, low-utility episodes, orphaned entities, old trace files.
3. **Before each session** — the PromptInjector reads the cached briefing and prepends it to the system prompt. Single fast SQLite read. No-op if no briefing cached.

### Knowledge Scopes

| Scope | Visibility | Derived From |
|-------|------------|-------------|
| **Agent** | Private to one agent | Default for all new triples |
| **Team** | Shared among agents with same `reportsTo` | Auto-promoted when teammates share facts |
| **Global** | All agents in the swarm | Auto-promoted from cross-team value |

Team membership is derived automatically from `reportsTo` — no manual declaration needed. The briefing query unions all three scope levels, sorted by confidence.

### Temporal Supersession

The knowledge graph maintains history. Only one version of a triple is active at any time per (source, predicate, target, createdBy) combination. When a newer extraction produces the same relationship, the previous version's `validTo` is set, and a new triple is inserted with `validTo = 0` (active). Old triples remain queryable for auditing.

## Mission Control Dashboard

Next.js 16 + React 19 + Zustand + Tailwind CSS v4. Connects via WebSocket (auto-reconnect with exponential backoff, 1s to 30s) and REST.

**7 views:**

| View | What It Shows |
|------|---------------|
| **Operations** | Real-time event feed (15 types, filterable by type/agent, expandable payload) |
| **Org Chart** | Interactive Canvas visualization with animated delegation particles, click-to-inspect |
| **Chat** | Orchestrator conversation with SSE streaming, markdown tables, persistent history |
| **Tasks** | Sortable/filterable task table with status badges and expandable details |
| **Knowledge Graph** | Force-directed graph of entities and triples, scope-filterable |
| **Agent Memory** | Split-panel: agent list + episodes, metrics, briefing, knowledge per agent |
| **Jobs** | Cron job management with run history, manual triggers, create/edit/delete |

## CLI Reference

| Command | Description |
|---------|-------------|
| `maximus` | Launch interactive TUI with chat, status bar, and slash commands |
| `maximus init` | Initialize project — creates `~/.maximus/` with full structure via interactive wizard |
| `maximus doctor` | Health check — validates 6 subsystems (agents, memory, vault, traces, deep sleep, skills) |
| `maximus server start [-f] [-p PORT]` | Start server (default: background). `-f` for foreground |
| `maximus server stop` | Graceful shutdown (SIGTERM, 5s timeout, SIGKILL) |
| `maximus server restart` | Stop + start |
| `maximus server status [--json]` | Status, PID, port, uptime, agent count |
| `maximus agents list [--json]` | List agents with metadata |
| `maximus agents org-chart` | Unicode tree of agent hierarchy |
| `maximus skills list [--json]` | List skills with tool/credential counts |
| `maximus chat "message"` | One-shot chat (SSE stream). No args = interactive REPL |
| `maximus vault set <name>` | Store encrypted credential (hidden input + optional description) |
| `maximus vault get <name>` | Decrypt and output (raw, pipe-friendly) |
| `maximus vault list [--json]` | List credentials (names only, never values) |
| `maximus vault delete <name>` | Delete with confirmation |
| `maximus memory status [--json]` | Entity/triple counts, episodes by agent, last consolidation |
| `maximus memory inspect <agent> [--json]` | Episodes, briefing, knowledge, metrics for one agent |
| `maximus memory promote <src> <pred> <tgt>` | Manually promote triple to higher scope |
| `maximus memory re-extract [--yes]` | Flush + reprocess all traces with current pipeline |
| `maximus memory reset [--yes]` | **Destructive.** Delete all traces and memory data |

### TUI Slash Commands

Inside the interactive TUI: `/start`, `/stop`, `/restart`, `/status`, `/init`, `/login`, `/vault set|get|list|delete`, `/new`, `/help`, `/exit`.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/agents` | GET | List agents (hot-reload on each call) |
| `/api/agents/org-chart` | GET | Agent hierarchy |
| `/api/chat` | POST | Send message, SSE response stream |
| `/api/chat/stream` | GET | Persistent session SSE stream |
| `/api/chat/message` | POST | Queue message to persistent session |
| `/api/chat/new` | POST | Reset persistent session |
| `/api/skills` | GET | List loaded skills |
| `/api/tasks` | GET | List tasks (filter: traceId, agentName, status) |
| `/api/jobs` | GET/POST | List/create scheduled jobs |
| `/api/jobs/:id` | PATCH/DELETE | Update/delete job |
| `/api/jobs/:id/run` | POST | Trigger immediate execution |
| `/api/memory/status` | GET | Memory system statistics |
| `/api/memory/graph` | GET | Knowledge graph data (optional scope filter) |
| `/api/memory/inspect/:agent` | GET | Agent memory details |
| `/api/memory/promote` | POST | Promote knowledge triple |
| `/ws` | WebSocket | Real-time event stream (15 event types) |

## Event Types

| Event | When | Key Payload |
|-------|------|-------------|
| `session:start` | Agent session begins | task, message |
| `session:end` | Session completes | success, totalCostUsd, numTurns |
| `agent:message` | Text output | content, chunked |
| `agent:tool_call` | Tool invoked | tool, input |
| `agent:tool_result` | Tool returns | tool, result, success |
| `agent:completion` | Turn complete | cost |
| `agent:error` | Session error | error, message |
| `task:created/assigned/completed/failed` | Task lifecycle | taskId, agent, result/error |
| `job:started/completed/failed` | Job lifecycle | jobId, jobName, durationMs |

Events flow through the EventBus to three consumers: **TraceLog** (JSONL persistence), **EventBridge** (WebSocket broadcast with backpressure handling), and the dashboard Zustand store.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAXIMUS_VAULT_KEY` | — | **Required.** Derives AES-256-GCM key via scrypt |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude API credential |
| `PORT` | 4100 | Server port |
| `AGENTS_DIR` | ./agents | Agent definition files |
| `SKILLS_DIR` | ./skills | Skill definition files |
| `MAXIMUS_VAULT_PATH` | — | Override vault file path |
| `MAXIMUS_MEMORY_DIR` | ./memory | Kuzu + SQLite location |
| `MAXIMUS_TRACES_DIR` | ./traces | JSONL trace storage |
| `MAXIMUS_DEEP_SLEEP_SCHEDULE` | `0 3 * * *` | Deep sleep cron schedule |

## Tech Stack

- **Runtime:** Node.js 22+, TypeScript 5.7
- **AI:** [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk) (`@anthropic-ai/claude-agent-sdk`)
- **CLI:** Ink + React 19 + Commander.js
- **Dashboard:** Next.js 16 + React 19 + Zustand + Tailwind CSS 4
- **Server:** Express 5 + WebSocket (ws) + Pino logging
- **Database:** SQLite (episodes, metrics, strategies), Kuzu (knowledge graph)
- **Crypto:** AES-256-GCM with scrypt key derivation (Node.js native)
- **Build:** Turborepo + tsup + pnpm workspaces
- **Quality:** Biome (lint + format), Vitest (testing)

## Documentation

| Guide | What It Covers |
|-------|----------------|
| [Getting Started](docs/getting-started.md) | Installation, init wizard, first agent team, dashboard walkthrough |
| [Agent Definitions](docs/agent-definition.md) | Full YAML schema, all fields, memory config, model selection |
| [Skill Definitions](docs/skill-definition.md) | Tool definitions, HTTP actions, parameter schemas, credential binding |
| [Multi-Agent Coordination](docs/multi-agent.md) | Hierarchy enforcement, delegation tools, circuit breakers, task lifecycle |
| [Credential Vault](docs/credential-vault.md) | AES-256-GCM details, proxy pattern, sanitization patterns, security model |
| [Knowledge Graph & Memory](docs/knowledge-graph.md) | Entities, triples, Kuzu schema, scope hierarchy, temporal supersession |
| [Knowledge Graph (Visual)](docs/knowledge-graph.html) | Interactive documentation with SVG diagrams of the full memory pipeline |
| [Dashboard](docs/dashboard.md) | All 7 views, 15 event types, WebSocket reconnection, Canvas org chart |
| [Memory Evolution](docs/memory-evolution.md) | Deep sleep pipeline stages, strategy registry, performance trends |

## License

MIT
