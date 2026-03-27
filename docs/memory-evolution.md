# Memory Evolution: Self-Improving Pipeline Architecture

How the Maximus memory pipeline evolves from basic episodic storage to a self-improving system where better traces produce better knowledge, which produces better agent performance, which produces better traces.

## Overview

The memory system draws inspiration from Meta's HyperAgents research on multi-agent memory architectures. The core insight is that agent memory should not be a static store that records and replays -- it should be a feedback loop where the quality of stored knowledge directly influences agent performance, and agent performance directly influences what gets stored.

Maximus implements this through a 7-stage deep sleep consolidation pipeline, metric-driven scope promotion, and prompt versioning for extraction quality tracking.

## Pipeline Architecture

The deep sleep pipeline runs as a scheduled consolidation job (default: 3 AM daily). It executes seven stages in strict order, with each stage feeding the next:

### Stage 1: Scan and Distill

`TraceReader` scans the traces directory for unprocessed JSONL files. `EpisodeDistiller` converts each trace into a structured episode with task description, outcome, lessons learned, strategies, and failure patterns. Tool call/result pairs are extracted to produce structured lesson summaries.

### Stage 2: Metrics Computation

`MetricsTracker` computes per-agent performance metrics over a 7-day sliding window: success rate, average turns, average cost, and total sessions. These metrics feed both briefings (performance trends) and the scope promoter (metric-driven promotion).

### Stage 3: Entity Extraction

`EntityExtractor` sends new episodes to Claude Sonnet with a prompt focused on operational knowledge. The extractor identifies entities (tools, APIs, strategies, error patterns) and relationships between them. Each extraction run is tracked against a prompt version with quality metrics.

### Stage 4: Scope Promotion

`ScopePromoter` evaluates agent-scoped knowledge for promotion to team or global scope. Promotion decisions consider retrieval frequency, cross-agent usage, and the discovering agent's performance metrics. High-performing agents' knowledge is promoted faster.

### Stage 5: Briefing Generation

`BriefingGenerator` assembles per-agent briefings from episodes, knowledge triples, and performance trends. Briefings are cached in SQLite and invalidated when new data arrives.

### Stage 6: Data Pruning

Stale triples (superseded and past retention window), low-utility episodes, and orphaned entities are cleaned up.

### Stage 7: Trace File Pruning

Processed trace files older than the configured retention period are deleted from disk.

## The Quality Loop

The pipeline creates a self-reinforcing quality loop:

```
Better traces (tool results captured)
    -> Better episodes (structured lessons with context)
        -> Better knowledge (operational entities and strategies)
            -> Better briefings (performance trends, relevant knowledge)
                -> Better agent performance
                    -> Better traces (more successful operations to learn from)
```

Each component in this loop has been designed to maximize the signal passed to the next:

- **Traces** capture tool results (not just tool calls), giving the distiller concrete data about what happened
- **Episodes** tag lessons with structured markers, making extraction reliable
- **Knowledge** uses a focused extraction prompt that targets operational patterns over generic facts
- **Briefings** prioritize failure lessons and performance trends, giving agents actionable context
- **Performance** improves because agents avoid known pitfalls and apply discovered strategies

## Extraction Evolution and Prompt Versioning

The entity extraction prompt is the most critical piece of the quality loop -- it determines what knowledge gets extracted from episodes. Small changes to the prompt can significantly affect extraction quality.

The prompt versioning system tracks this evolution:

1. Each extraction prompt is hashed (SHA-256, first 16 chars) and stored in a `prompt_versions` table
2. Every extraction run records quality metrics in an `extraction_metrics` table: entities per episode, triples per episode, and unique entity ratio
3. When the extraction prompt changes (due to manual improvement), a new version is automatically created

Currently prompt changes are manual -- a developer modifies the extraction prompt in `EntityExtractor.buildPrompt()` and the system tracks the quality impact. The infrastructure is designed for future automated A/B testing where multiple prompt versions run in parallel and metrics determine which version produces higher-quality knowledge.

### Quality Metrics

| Metric | What it measures | Good values |
|--------|-----------------|-------------|
| Entities per episode | Extraction richness | 2-5 (too low = missing knowledge, too high = noise) |
| Triples per episode | Relationship density | 1-3 (meaningful connections between entities) |
| Unique entity ratio | Deduplication quality | 0.7-1.0 (lower = too many duplicate entity names) |

## Metric-Driven Promotion

Agent performance metrics influence knowledge propagation through the scope hierarchy:

- **High performers** (>80% success rate): Knowledge promoted at standard thresholds -- their discoveries are treated as reliable
- **Average performers** (30-80%): Standard promotion thresholds apply
- **Low performers** (<30% success rate): Knowledge held back from automatic promotion until confirmed by another agent

This prevents a struggling agent from polluting the team knowledge graph with potentially incorrect patterns while allowing successful agents' discoveries to spread quickly.

## Strategy Discovery

The extraction prompt specifically looks for operational strategies -- workflow patterns that agents discover through experience. Examples:

- "set-leverage-before-orders" -- discovered when an agent failed to place orders because leverage wasn't configured first
- "use-jina-for-protected-sites" -- discovered when direct HTTP fetches returned 403 but Jina Reader succeeded
- "batch-upload-over-50-leads" -- discovered when individual lead creation was too slow for large campaigns

Strategies are extracted as entities with type `strategy` and linked to the discovering agent via a `discovered_by` relationship. When the same strategy is discovered independently by 2 or more agents on the same team, `ScopePromoter` automatically promotes it to team scope, making it available in all team members' briefings.

### Strategy Registry

Beyond the knowledge graph, a `strategy_registry` SQLite table tracks concrete usage metrics for each strategy per agent: how many times it was used, how many successes and failures, and the resulting success rate. The deep-sleep pipeline populates this registry after distillation by recording each `effectiveStrategies` entry alongside the episode outcome.

Briefings surface the top strategies as a "Proven Strategies" section with usage counts and success rates, giving agents data-driven confidence in which patterns to apply.

## Future Directions

Several enhancements are planned for the memory pipeline:

- **Automated prompt evolution** -- A/B test multiple extraction prompts simultaneously, automatically selecting the version that produces higher-quality knowledge based on downstream metrics
- **Vector embeddings** -- Add semantic similarity search alongside the structured graph, enabling briefings to include knowledge that is conceptually related to the current task even if not explicitly linked
- **LLM-based distiller** -- Replace the heuristic distiller with an LLM that produces richer episode summaries, especially for complex multi-step sessions
- **Cross-swarm knowledge** -- Share validated global-scope knowledge between separate Maximus deployments

## See Also

- [Knowledge Graph](./knowledge-graph.md) -- detailed architecture of the knowledge graph and memory system
- [Getting Started](./getting-started.md) -- enabling memory for your first agent
