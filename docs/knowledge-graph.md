# Knowledge Graph & Agent Memory

Maximus agents accumulate structured memory across sessions. The memory system extracts entities and relationships from agent experiences, stores them in a temporal knowledge graph, and injects relevant context into each agent's system prompt before the next session begins. The result is an agent that learns from its mistakes, remembers what it discovered, and shares that knowledge with its teammates.

## Why Two Databases?

The memory system uses two databases with different strengths:

| Database | Purpose |
|----------|---------|
| **Kuzu** (embedded graph DB) | Entities, relationships, and knowledge triples — queryable via Cypher |
| **SQLite** | Episodes, briefings, metrics, and delegation tracking |

These complement each other. Kuzu excels at graph traversal queries — "give me everything related to the Instantly API within two hops, scoped to this team" — while SQLite excels at row-based operations like "show the last 10 episodes for this agent sorted by timestamp" or "check whether the cached briefing is still valid." Forcing graph traversals into SQLite or episode storage into Kuzu would result in awkward schema design in both directions.

Both databases are accessed through a single `MemoryEngine` facade that lazy-initializes both on first use. When the first agent with `episodic: true` starts a session, `MemoryEngine` opens the Kuzu store and SQLite file from the configured data directory (default: `~/.maximus/memory/`). Neither database opens a network connection — both are embedded and file-local, which means zero infrastructure beyond the Maximus process itself.

## Architecture Components

### EpisodeDistiller

The `EpisodeDistiller` converts raw session traces into structured episodes. During a session, the runtime emits a stream of events to a JSONL trace file: tool calls, tool results, agent messages, sub-delegation events, errors, and a final `session:end` event that records whether the task succeeded or failed. These trace files are not immediately processed — they accumulate on disk until the deep sleep consolidation window.

During consolidation, `EpisodeDistiller` reads each unprocessed trace file and produces an episode record with three fields:

- **what happened** — a concise summary of the task and the steps taken
- **outcome** — `success`, `failure`, or `partial`, derived from the `session:end` event
- **lessons** — a short list of takeaways: what worked, what failed, and any constraints discovered (rate limits, auth requirements, pagination patterns, etc.)

The distiller looks at the `task` field on the `session:end` event for the task description. If no explicit task description is present, it falls back to the first user message in the trace. Lessons are extracted by scanning tool errors, retry patterns, and terminal states — a `429` error followed by a backoff-and-retry sequence gets summarized as "rate limit encountered; backoff resolved it." A session that ends in `failure` with a final tool error produces a lesson about that specific failure mode.

Episodes are inserted into SQLite with a reference to the source trace file path. The trace file is left on disk and only cleaned up by the optional `--prune-traces` flag to `maximus memory status`.

### EntityExtractor

The `EntityExtractor` runs Claude Haiku over new SQLite episodes to extract named entities and the relationships between them, writing the results into the Kuzu knowledge graph.

Haiku is used deliberately here rather than a larger model: entity extraction is a well-structured task with a clear output schema, the volume can be high (many episodes per consolidation run), and cost matters at scale. The extractor prompts Haiku with the episode summary and lessons, asking it to return a structured JSON list of entities (name, type, attributes) and triples (source, predicate, target, confidence).

Entity types follow a small fixed taxonomy: `api`, `tool`, `agent`, `concept`, `error`, `project`, `client`. Haiku is instructed to use custom strings for domain-specific concepts that don't fit these categories. Confidence values reflect how clearly the fact was established in the episode — a direct assertion ("the API has a 10 req/s rate limit") scores 0.9–1.0, while an inferred relationship ("agent A seems to depend on tool B") might score 0.6–0.7.

The extractor deduplicates entities by name before inserting them. If an entity with the same name already exists in Kuzu, attributes are merged and the existing node is updated rather than duplicated. New triples are inserted using the temporal supersession protocol (described below).

### KnowledgeStore

`KnowledgeStore` is the read/write interface to the Kuzu graph. It provides typed methods for common operations rather than raw Cypher, though you can pass Cypher strings directly when needed.

Internally, KnowledgeStore translates scope queries into Cypher `WHERE` clauses. A typical briefing query looks like:

```cypher
MATCH (s:Entity)-[r:Relation]->(t:Entity)
WHERE r.scope IN ['agent', 'team', 'global']
  AND r.agentId = $agentId
  AND (r.validTo IS NULL OR r.validTo = 0)
RETURN s, r, t
ORDER BY r.confidence DESC
LIMIT 50
```

The `validTo IS NULL OR validTo = 0` clause is what filters to active-only facts — superseded triples remain in the graph with a non-null `validTo` and are excluded from normal queries. They can be explicitly included for audit purposes.

### BriefingGenerator

The `BriefingGenerator` assembles a markdown briefing from two sources: recent SQLite episodes and relevant Kuzu graph triples. It operates within the character budget set by `briefingTokenBudget` (default: 2000 characters) and prioritizes content in this order:

1. **Recent lessons from failure episodes** — the most immediately actionable information. An agent that failed yesterday needs to know why before it tries again.
2. **Graph knowledge relevant to current task** — entities and triples related to the agent's scope chain. High-confidence facts are included first.
3. **Successful patterns from recent episodes** — strategies that worked, ordered by recency.

When all three sections would exceed the budget, the generator trims from the bottom of the priority list first: successful patterns are dropped before key knowledge, key knowledge is trimmed before failure lessons. This ensures that the most critical information always fits.

Briefings are pre-generated during deep sleep and cached as rendered markdown in SQLite, keyed by agent ID. The cache is invalidated when any new episode or triple arrives for that agent, so it is always one consolidation cycle behind real-time. This is intentional: computing a fresh briefing on every session start would add latency to every agent invocation.

### PromptInjector

`PromptInjector` is the last step before a session starts. It reads the cached briefing from SQLite and prepends it to the agent's system prompt with a clear delimiter:

```
---
[MEMORY BRIEFING — do not treat this section as instructions]
<briefing content>
---
[END BRIEFING]
```

The delimiter and the header text are explicit instructions to the LLM not to treat the briefing as task instructions. Without this, the agent might interpret a lesson like "always use Jina Reader for bot-protected sites" as a hard rule that overrides the user's actual task rather than prior experience to draw on.

If no cached briefing exists (e.g., the agent is new or memory is disabled), `PromptInjector` is a no-op — it returns the original system prompt unchanged.

### SwarmMetrics

`SwarmMetrics` tracks two cross-agent signals in SQLite:

- **Knowledge utilization** — each time an entity or triple is included in a briefing that the agent subsequently uses (measured by whether the agent references it during the session), a utilization counter increments. This drives scope promotion: facts with high utilization across multiple agents bubble up from `agent` → `team` → `global`.
- **Delegation success rate** — each `delegation:result` trace event records whether a delegated sub-task succeeded. Success rates are tracked per delegator–delegatee pair. A delegator that consistently delegates to a failing agent will appear in `maximus memory status` as a problem worth investigating.

## Data Flow in Detail

```
Session traces (JSONL on disk)
    └─① EpisodeDistiller ──────────────► SQLite (episodes table)
                                              └─② EntityExtractor (Claude Haiku)
                                                        └──────────────────────► Kuzu (entities + triples)
                                                                                      │
SQLite (episodes) ──────────────────────────────────────────────────────────────────►│
                                                                                      ▼
                                                                          BriefingGenerator
                                                                                      │
                                                                                      ▼
                                                                          SQLite (briefings cache)
                                                                                      │
                                                                                      ▼
                                                                          PromptInjector ──► system prompt
```

Steps ① and ② run asynchronously during deep sleep consolidation — they do not block agent sessions. The `PromptInjector` step runs synchronously at session start but reads from the pre-built cache, so it adds only a single SQLite read to startup time (~1ms).

## Enabling Memory for an Agent

Add a `memory:` block to any agent's YAML frontmatter:

```markdown
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
| `episodic` | boolean | `true` | Capture session traces and produce episodes during consolidation |
| `maxEpisodes` | number | `50` | Maximum episodes retained per agent; oldest are pruned when the limit is reached |
| `knowledgeScopes` | string[] | `[]` | Additional team scopes to include in briefing queries beyond the natural scope chain |
| `briefingEnabled` | boolean | `true` | Whether to inject a briefing before each session |
| `briefingTokenBudget` | number | `2000` | Maximum character count for briefing content (not tokens — the name is historical) |
| `learningRate` | string | `"moderate"` | Controls how readily facts are promoted up the scope hierarchy: `conservative` requires more evidence, `aggressive` promotes sooner |

Setting `episodic: false` disables trace capture entirely — no JSONL files are written, and no episodes are produced. Setting `briefingEnabled: false` while keeping `episodic: true` means episodes and graph facts are still accumulated but never injected, which can be useful for background analytics agents.

## Knowledge Graph Concepts

### Entities

Entities are named, typed nodes in the Kuzu graph. They represent stable, reusable concepts extracted from agent experiences — things that persist across sessions and that multiple agents might need to know about.

| Type | Example | When extracted |
|------|---------|----------------|
| `api` | Instantly API, GitHub API | Agent makes API calls; rate limits or auth patterns observed |
| `tool` | web-search, send-email, Jina Reader | Agent uses a tool repeatedly or discovers a trick about it |
| `agent` | deploy-agent, research-manager | Agent delegates to another agent; outcome recorded |
| `concept` | rate limiting, pagination, bot protection | Abstract pattern that appears across multiple tools or sessions |
| `error` | 429 Too Many Requests, 403 Forbidden | Error that required a specific resolution strategy |
| `project` | Project Apollo | Work context referenced across multiple sessions |
| `client` | Acme Corp | Client context that affects how tasks should be approached |

Entity types can also be arbitrary strings for domain-specific concepts not covered by the taxonomy. The extractor is instructed to prefer taxonomy types when they fit and use custom strings only when they don't.

Entities have an `attributes` map (stored as JSON in Kuzu) that captures key-value facts about the entity itself — for example, an `api` entity might have `{ "baseUrl": "https://api.instantly.ai/v2", "rateLimit": "10/s", "authType": "bearer" }`. Attributes are merged across extractions: if two different episodes both discover something about the Instantly API, their attributes are unioned.

### Knowledge Triples

Relationships between entities are stored as temporal triples: **source → predicate → target**.

```
Instantly API  --[rate_limit = 10 req/sec]-->  sending operations
deploy-agent   --[depends_on]-->               staging-env
web-researcher --[learned_about]-->            pagination cursors
Jina Reader    --[bypasses]-->                 bot-403 error
```

Each triple carries:

| Field | Type | Description |
|-------|------|-------------|
| `predicate` | string | Short verb phrase: `uses`, `depends_on`, `failed_with`, `learned_about`, `works_with`, `bypasses`, `rate_limit` |
| `scope` | string | Visibility level: `agent`, `team`, or `global` |
| `confidence` | float 0–1 | How certain is this fact? Direct assertions score 0.9–1.0; inferences score lower |
| `evidence` | string | The episode ID that produced this triple, for traceability |
| `validFrom` | Unix timestamp | When this version of the triple became active |
| `validTo` | Unix timestamp or null | When this triple was superseded; `null` means currently active |
| `createdBy` | string | The agent that ran the extraction (may differ from the agent that had the experience) |

The predicate vocabulary is open — the extractor can create new predicates when none of the common ones fit. This keeps the graph flexible without requiring a fixed ontology.

### Temporal Supersession

When a new fact contradicts an existing one (same source entity, same predicate, same target entity), the old triple is not deleted. Instead:

1. The old triple's `validTo` is set to the current timestamp
2. The new triple is inserted with `validFrom = now` and `validTo = null`

Both triples remain in the graph. Normal queries filter to `validTo IS NULL` and see only the active version. Audit queries can include superseded triples to reconstruct how an agent's knowledge has changed over time — for example, to verify that an agent correctly updated its understanding after a failed session.

This append-only model has an important consequence: you can never "overwrite" a fact silently. Every belief change is recorded with a timestamp and the episode that caused it. If an agent suddenly starts behaving differently, you can look at the triple history to see what changed in its knowledge graph.

## Scope Hierarchy

Knowledge is organized in three nested scope levels that determine which agents can read a given fact:

| Scope | Who can read it | Typical use |
|-------|----------------|-------------|
| `agent` | Only the creating agent | Private discoveries not yet validated across sessions |
| `team` | All agents sharing the same `reportsTo` value | Patterns useful to a specific team (e.g., all research agents) |
| `global` | Every agent in the swarm | Cross-cutting facts (rate limits, API auth patterns, known errors) |

**Team membership is derived automatically** from the `reportsTo` field in agent YAML frontmatter. No manual team declaration is needed — all agents with the same `reportsTo` string are on the same team. An agent without a `reportsTo` field is on no team and sees only its own private knowledge plus global knowledge.

When a briefing is generated, the scope query unions all three levels in the agent's chain:

1. Facts with `scope='agent'` created by this specific agent
2. Facts with `scope='team'` created by any agent on the same team
3. Facts with `scope='global'`

The result is sorted by confidence descending and trimmed to the briefing budget.

### Accessing Additional Scopes

The `knowledgeScopes` field lets an agent reach into other teams' knowledge beyond its natural hierarchy. This is useful for cross-functional agents that straddle team boundaries:

```yaml
memory:
  knowledgeScopes:
    - infra-team   # also query facts created by agents reporting to infra-lead
    - data-team    # also query facts from data pipeline agents
```

An empty array (the default) means the agent sees only its own scope chain. Adding a scope string causes the briefing query to also include `scope='team'` facts from agents that report to the named manager.

### Scope Promotion

During deep sleep consolidation, the system automatically promotes high-utility facts up the scope hierarchy:

- A `scope='agent'` fact that has been retrieved and used in multiple sessions by more than one agent on the same team is promoted to `scope='team'`
- A `scope='team'` fact that has been retrieved and used across multiple different teams is promoted to `scope='global'`

The `learningRate` setting controls the utilization threshold required for promotion:

| Setting | Promotion threshold | When to use |
|---------|--------------------|-----------:|
| `conservative` | High utilization across many agents | When you want to avoid noisy or premature promotions |
| `moderate` | Medium utilization (default) | Balanced — works well for most swarms |
| `aggressive` | Low utilization, promotes quickly | When you want knowledge to spread fast |

You can also manually promote a specific triple regardless of utilization:

```bash
maximus memory promote <sourceId> <predicate> <targetId>
```

## Agent Briefings

Before each session starts, if `briefingEnabled: true`, the runtime reads the pre-cached briefing for the agent from SQLite and prepends it to the system prompt. Here is what a typical briefing looks like in practice:

```markdown
## Session Briefing for researcher

### Recent Lessons
- [failure] Task "scrape pricing page" failed: site returned 403 on direct fetch (1 day ago)
- [success] Used Jina Reader API to bypass bot protection successfully (1 day ago)

### Key Knowledge
- **Jina Reader API**: bypasses_bot_protection = true (confidence: 0.95)
- **pricing-scraper** depends_on **Jina Reader API** (confidence: 0.9)

### Active Strategies
- Always try Jina Reader API before direct fetch for protected sites
- Check for pagination cursors in API responses before assuming end of data
```

The briefing is intentionally compact. Its purpose is not to replace the agent's training but to surface the specific, hard-won facts about this agent's environment that wouldn't otherwise be available. An agent that spent two sessions learning how to reliably paginate a particular API shouldn't have to rediscover that in session three.

Briefings are generated during deep sleep and cached in SQLite. A briefing is invalidated (marked for regeneration on the next consolidation run) when any new episode or triple is written for the agent. This means briefings are always at most one consolidation cycle old — by default, less than 24 hours stale.

## Deep Sleep Consolidation

The consolidation pipeline runs on a cron schedule (default: 3 AM daily). It processes all accumulated session traces since the last run:

### Step 1 — Trace Analysis
The pipeline scans the trace directory for JSONL files that haven't been processed yet (tracked by a watermark in SQLite). It loads each file and validates its structure.

### Step 2 — Episode Distillation
`EpisodeDistiller` processes each trace file, extracting task, outcome, and lessons. Episodes are inserted into SQLite. This step is fast — it's pure parsing and SQL writes, no LLM calls.

### Step 3 — Entity Extraction
`EntityExtractor` batches the new episodes and sends them to Claude Haiku in parallel requests. For each episode, Haiku returns a list of entities and triples to upsert into Kuzu. This is the most expensive step in the pipeline (it involves LLM API calls), but it only runs on *new* episodes, so costs scale with session activity rather than swarm size.

### Step 4 — Briefing Generation
`BriefingGenerator` queries the Kuzu graph and SQLite episodes for each agent that had new activity, assembles a briefing, and writes it to the SQLite cache. Agents with no new activity since the last consolidation are skipped.

### Step 5 — Stale Knowledge Pruning
Triples with a `validTo` timestamp older than the configured retention window (default: 90 days) are removed from Kuzu. This prevents the graph from growing indefinitely with obsolete facts that no longer apply. Episodes older than `maxEpisodes` are pruned from SQLite.

### Step 6 — Scope Promotion
High-utilization facts are promoted to wider scopes based on the `learningRate` thresholds. The utilization counters in `SwarmMetrics` are read, qualifying triples are promoted (a new triple is inserted at the higher scope, the old one is expired), and the counters are reset.

Configure the schedule with the `MAXIMUS_DEEP_SLEEP_SCHEDULE` environment variable (cron syntax):

```bash
export MAXIMUS_DEEP_SLEEP_SCHEDULE="0 3 * * *"  # 3 AM daily (default)
export MAXIMUS_DEEP_SLEEP_SCHEDULE="0 */6 * * *" # every 6 hours for high-volume swarms
```

Running `maximus memory status` will show when the last consolidation ran and how many items were processed.

## Dashboard — Knowledge Graph View

The Mission Control dashboard includes a **Knowledge Graph** view that renders the Kuzu graph as an interactive node-edge diagram. Nodes are entities; edges are active triples (those with `validTo = null`).

Clicking a node opens a side panel showing:
- Entity name, type, and attributes
- All active triples involving this entity
- The episode that produced each triple
- Confidence scores and timestamps

Use the scope filter in the toolbar to show only `agent`, `team`, or `global` facts, or combine scopes. Use the agent filter to narrow the graph to a single agent's view of the world — what it knows vs. what it contributes.

Superseded triples are hidden by default. Toggle **Show history** in the toolbar to visualize how beliefs changed over time (superseded edges appear as dashed lines with a strikethrough label).

## CLI Commands

```bash
# Show overall memory system status — episode counts, graph size, briefing cache state,
# last consolidation timestamp, and top agents by knowledge utilization
maximus memory status

# Inspect a specific agent's memory: recent episodes with outcomes and lessons,
# known entities and triples in its scope chain, and the current cached briefing
maximus memory inspect <agent-name>

# Manually promote a triple to a higher scope, bypassing the utilization threshold
maximus memory promote <sourceId> <predicate> <targetId>
```

## Swarm Metrics

The memory system tracks two cross-agent metrics in SQLite:

| Metric | What it measures | Where to see it |
|--------|-----------------|-----------------|
| **Knowledge utilization** | How often entities and triples from the graph appear in briefings that the agent actually acted on — per-agent and swarm-wide | Dashboard Observability view; `maximus memory status` |
| **Delegation success rate** | Success/failure outcomes per delegator–delegatee pair, derived from `delegation:result` trace events | Dashboard Agents view; `maximus memory status` |

Knowledge utilization is the feedback loop that makes the scope promotion system self-reinforcing: the more agents use a piece of knowledge, the faster it propagates to a wider scope, which means more agents see it, which increases utilization further. Facts that are extracted but never retrieved will eventually be pruned.

Delegation success rates help identify structural problems in multi-agent workflows — for example, an orchestrator that repeatedly delegates the same task class to an agent that reliably fails at it. These metrics don't cause automatic behavior changes; they surface in the dashboard for human review.

## Metacognitive Features

The memory system includes several metacognitive capabilities that enable agents to reason about their own performance and adapt over time.

### Trace Format and Tool Result Capture

Session traces capture `tool_result` events alongside `tool_call` events. This pairing allows the distiller to produce structured lessons like "Called `get_account_state` -> returned equity $116.86" instead of generic summaries. The `maxToolResultChars` config option (in agent memory config) controls how much of each tool result is captured, balancing detail against storage cost.

### Distiller Quality

The distiller extracts tool call/result pairs from trace events, replacing earlier regex-based heuristics. Each lesson now contains a structured summary of what the agent did and what happened, making downstream entity extraction significantly more precise. Lessons are tagged with structured markers (`[LESSON]`, `[STRATEGY]`, `[FAILURE]`) for reliable parsing.

### Regression Detection

The distiller flags `REGRESSION` in `failurePatterns` when an agent fails at a task it previously succeeded at. This is detected by comparing the current episode outcome against the agent's historical episodes for the same task class. Regressions surface prominently in briefings so the agent is aware it is performing worse than before.

### Performance Trends in Briefings

Agents receive performance trend data in their session briefings: success rate direction (UP/DOWN/STABLE), cost trends, and failure concentration data. This gives agents awareness of whether they are improving or degrading, and which areas need attention. Trends are computed over a 7-day sliding window from the `agent_metrics` table.

### Strategy Entities

A `strategy` entity type captures operational patterns discovered by agents during sessions. Examples include "set-leverage-before-orders" (an ordering dependency discovered from failures) or "use-jina-for-protected-sites" (a workaround discovered through experimentation). When a strategy is discovered by 2 or more agents on the same team, the scope promoter automatically promotes it to team scope, making it available to all team members.

#### Strategy Registry

The `strategy_registry` SQLite table tracks usage counts and success correlation for each strategy per agent. Every time the distiller extracts an `effectiveStrategies` entry from an episode, it records the strategy text, the episode outcome (success/failure), and increments counters. Each registry row stores `usageCount`, `successCount`, `failureCount`, and a computed `successRate`.

Briefings include a "Proven Strategies" section that queries the registry for the agent's top strategies by usage, displaying each with its usage count and success rate (e.g., "Batch processing (used 12x, 83% success rate)"). This gives agents concrete data on which patterns actually work.

### Metric-Driven Promotion

Agent performance metrics influence how quickly knowledge propagates through the scope hierarchy. Knowledge from high-performing agents (>80% success rate over the 7-day window) is promoted faster -- their discoveries are treated as more reliable. Knowledge from low-performing agents (<30% success rate) is held back from promotion until confirmed by other agents, preventing bad patterns from spreading.

### Extraction Quality and Prompt Versioning

The entity extractor uses Claude Sonnet (not Haiku) with a prompt focused on operational knowledge extraction. Each extraction prompt is version-tracked: a SHA-256 hash of the prompt text is stored in a `prompt_versions` table along with the full prompt text and creation timestamp. Quality metrics (entities per episode, triples per episode, unique entity ratio) are recorded per version in an `extraction_metrics` table. This infrastructure enables future A/B testing of extraction prompts to continuously improve knowledge quality.

## See Also

- [Agent Definition Format](./agent-definition.md) — full frontmatter schema including the `memory:` block
- [Multi-Agent Coordination](./multi-agent.md) — how delegation, teams, and scope hierarchy relate
- [Getting Started](./getting-started.md) — enabling memory in your first agent
- [Memory Evolution](./memory-evolution.md) — self-improving pipeline architecture
