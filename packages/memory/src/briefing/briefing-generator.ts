import type { Episode } from "@maximus/shared";
import type { EpisodeStore } from "../sqlite/episodes.js";
import type { KnowledgeStore, ScopeChainResult } from "../kuzu/knowledge-store.js";
import type { BriefingStore } from "../sqlite/briefing-store.js";
import type { MetricsTracker } from "../sqlite/metrics.js";
import type { StrategyRegistry } from "../sqlite/strategy-registry.js";

/**
 * Assembles markdown briefings from episodes + knowledge graph data.
 * Caches results in BriefingStore with invalidation support.
 *
 * Sections are built in priority order and truncated to fit the token budget:
 * 1. Header (always included)
 * 2. Recent Lessons (failures first, then partial, then success)
 * 3. Performance Trends (success rate, cost, failure concentration)
 * 4. Key Knowledge (sorted by confidence desc)
 * 5. Proven Strategies (usage counts + success correlation from registry)
 */
export class BriefingGenerator {
	constructor(
		private episodeStore: EpisodeStore,
		private knowledgeStore: KnowledgeStore,
		private briefingStore: BriefingStore,
		private metricsTracker?: MetricsTracker,
		private strategyRegistry?: StrategyRegistry,
	) {}

	/**
	 * Generate a briefing for the given agent. Returns cached version if valid.
	 * Returns null if the agent has no episodes and no knowledge.
	 */
	async generate(
		agentName: string,
		teamMembers: string[],
		tokenBudget: number = 2000,
	): Promise<string | null> {
		// Check cache first
		if (this.briefingStore.isValid(agentName)) {
			const cached = this.briefingStore.get(agentName);
			if (cached) return cached.content;
		}

		// Fetch data
		const episodes = this.episodeStore.getByAgent(agentName, 10);
		const triples = await this.knowledgeStore.getByScope(
			agentName,
			teamMembers,
		);

		// No data = no briefing
		if (episodes.length === 0 && triples.length === 0) {
			return null;
		}

		// Build sections in priority order
		const header = `## Session Briefing for ${agentName}\n\n`;
		let remaining = tokenBudget - header.length;
		const sections: string[] = [header];

		// Priority 1: Recent Lessons
		const lessonsSection = this.buildLessonsSection(episodes);
		if (lessonsSection && lessonsSection.length <= remaining) {
			sections.push(lessonsSection);
			remaining -= lessonsSection.length;
		} else if (lessonsSection && remaining > 30) {
			// Truncate to fit
			sections.push(lessonsSection.slice(0, remaining));
			remaining = 0;
		}

		// Priority 2: Performance Trends (D-16)
		if (remaining > 0) {
			const trendsSection = this.buildPerformanceTrendsSection(agentName, episodes);
			if (trendsSection && trendsSection.length <= remaining) {
				sections.push(trendsSection);
				remaining -= trendsSection.length;
			} else if (trendsSection && remaining > 30) {
				sections.push(trendsSection.slice(0, remaining));
				remaining = 0;
			}
		}

		// Priority 3: Key Knowledge
		if (remaining > 0 && triples.length > 0) {
			const knowledgeSection = this.buildKnowledgeSection(triples);
			if (knowledgeSection.length <= remaining) {
				sections.push(knowledgeSection);
				remaining -= knowledgeSection.length;
			} else if (remaining > 30) {
				sections.push(knowledgeSection.slice(0, remaining));
				remaining = 0;
			}
		}

		// Priority 4: Proven Strategies (usage counts + success correlation)
		if (remaining > 0) {
			const strategiesSection = this.buildProvenStrategiesSection(agentName, episodes);
			if (strategiesSection && strategiesSection.length <= remaining) {
				sections.push(strategiesSection);
			} else if (strategiesSection && remaining > 30) {
				sections.push(strategiesSection.slice(0, remaining));
			}
		}

		const content = sections.join("");

		// Cache the result
		this.briefingStore.save({
			agentName,
			content,
			generatedAt: new Date().toISOString(),
			episodeIds: episodes.map((e) => e.id),
			invalidated: false,
		});

		return content;
	}

	/**
	 * Build the Recent Lessons section. Failures first, then partial, then success.
	 */
	private buildLessonsSection(episodes: Episode[]): string | null {
		if (episodes.length === 0) return null;

		// Sort: failures first, partial second, success last
		const sorted = [...episodes].sort((a, b) => {
			const order = { failure: 0, partial: 1, success: 2 };
			return (order[a.outcome] ?? 2) - (order[b.outcome] ?? 2);
		});

		const lines: string[] = ["### Recent Lessons\n"];
		for (const ep of sorted) {
			const lesson = ep.lessonsLearned[0] ?? "No lesson recorded";
			const timeAgo = this.relativeTime(ep.timestamp);
			lines.push(
				`- [${ep.outcome}] ${ep.taskDescription}: ${lesson} (${timeAgo})\n`,
			);
		}
		lines.push("\n");

		return lines.join("");
	}

	/**
	 * Build the Key Knowledge section from scope-chain triples.
	 */
	private buildKnowledgeSection(triples: ScopeChainResult[]): string {
		// Sort by confidence descending
		const sorted = [...triples].sort(
			(a, b) => b.triple.confidence - a.triple.confidence,
		);

		const lines: string[] = ["### Key Knowledge\n"];
		for (const { entity, triple, target } of sorted) {
			lines.push(
				`- **${entity.name}** ${triple.predicate} **${target.name}** (confidence: ${triple.confidence})\n`,
			);
		}
		lines.push("\n");

		return lines.join("");
	}

	/**
	 * Build the Proven Strategies section. Uses StrategyRegistry for usage counts
	 * and success correlation when available, falls back to episode-based logic.
	 */
	private buildProvenStrategiesSection(agentName: string, episodes: Episode[]): string | null {
		if (this.strategyRegistry) {
			const strategies = this.strategyRegistry.getTopStrategies(agentName, 5);
			// Filter out strategies with usageCount < 2 (single-use = noise)
			const proven = strategies.filter((s) => s.usageCount >= 2);
			if (proven.length === 0) return null;

			const lines: string[] = ["### Proven Strategies\n"];
			for (const s of proven) {
				const rate = Math.round(s.successRate * 100);
				lines.push(`- **${s.strategyText}** (used ${s.usageCount}x, ${rate}% success rate)\n`);
			}
			lines.push("\n");
			return lines.join("");
		}

		// Fallback: episode-based strategies (backward compat)
		const successful = episodes.filter((e) => e.outcome === "success");
		const strategies = successful.flatMap((e) => e.effectiveStrategies);
		const unique = [...new Set(strategies)];

		if (unique.length === 0) return null;

		const lines: string[] = ["### Active Strategies\n"];
		for (const strategy of unique) {
			lines.push(`- ${strategy}\n`);
		}
		lines.push("\n");

		return lines.join("");
	}

	/**
	 * Build the Performance Trends section from MetricsTracker data.
	 * Compares current 7-day window against prior 7-day window for trend indicators.
	 * Includes failure concentration analysis by task type.
	 */
	private buildPerformanceTrendsSection(
		agentName: string,
		episodes: Episode[],
	): string | null {
		// D-17: Skip if no MetricsTracker or fewer than 3 episodes
		if (!this.metricsTracker || episodes.length < 3) return null;

		const DAY = 86_400_000;
		const now = Date.now();

		// Get current 7-day metrics
		const current = this.metricsTracker.computeAndStore(agentName, now - 7 * DAY, now);
		// Get prior 7-day window for comparison
		const priorSnapshots = this.metricsTracker.getByWindow(agentName, now - 14 * DAY, now - 7 * DAY);

		if (current.totalSessions < 3) return null; // D-17

		const lines: string[] = ["### Performance Trends\n\n"];

		// Success rate with trend indicator
		if (current.successRate !== undefined) {
			const currentRate = Math.round(current.successRate * 100);
			let indicator = "--";
			if (priorSnapshots.length > 0 && priorSnapshots[0].successRate !== undefined) {
				const priorRate = priorSnapshots[0].successRate;
				if (current.successRate > priorRate + 0.05) indicator = "UP";
				else if (current.successRate < priorRate - 0.05) indicator = "DOWN";
				else indicator = "STABLE";
			}
			lines.push(`- Success Rate: ${currentRate}% (${indicator})\n`);
		}

		// Avg cost trend
		if (current.avgCostUsd !== undefined) {
			lines.push(`- Avg Cost: $${current.avgCostUsd.toFixed(4)}/task\n`);
		}

		// Failure concentration by task type
		const failures = episodes.filter(e => e.outcome === "failure");
		if (failures.length > 0) {
			const taskCounts = new Map<string, number>();
			for (const f of failures) {
				const key = f.taskDescription.slice(0, 60);
				taskCounts.set(key, (taskCounts.get(key) ?? 0) + 1);
			}
			// Sort by count desc, take top 3
			const sorted = [...taskCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
			if (sorted.length > 0) {
				lines.push("- Failure concentration:\n");
				for (const [task, count] of sorted) {
					lines.push(`  - "${task}" (${count} failures)\n`);
				}
			}
		}

		lines.push("\n");
		return lines.join("");
	}

	/**
	 * Format a timestamp as a human-readable relative time.
	 */
	private relativeTime(timestamp: number): string {
		const diff = Date.now() - timestamp;
		const minutes = Math.floor(diff / 60_000);
		const hours = Math.floor(diff / 3_600_000);
		const days = Math.floor(diff / 86_400_000);

		if (days > 0) return `${days}d ago`;
		if (hours > 0) return `${hours}h ago`;
		if (minutes > 0) return `${minutes}m ago`;
		return "just now";
	}
}
