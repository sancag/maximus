import { nanoid } from "nanoid";
import type { AgentEvent } from "@maximus/shared";
import type { Episode, EpisodeOutcome } from "@maximus/shared";
import type { EpisodeStore } from "../sqlite/episodes.js";

/**
 * A matched tool call/result pair extracted from trace events.
 */
interface ToolPair {
	tool: string;
	input: Record<string, unknown>;
	result?: string;
	success: boolean;
	error?: string;
}

/**
 * Converts an array of AgentEvents from a trace into a structured Episode record.
 * Extracts lessons from tool call/result pairs (no LLM calls, pure heuristics).
 */
export class EpisodeDistiller {
	constructor(private episodeStore?: EpisodeStore) {}

	/**
	 * Check if this failure is a regression (agent previously succeeded at same task).
	 * Uses exact taskDescription matching (D-19).
	 */
	private checkRegression(
		agentName: string,
		taskDescription: string,
		outcome: EpisodeOutcome,
	): string | null {
		if (outcome !== "failure" || !this.episodeStore) return null;

		const history = this.episodeStore.getByAgent(agentName, 50);
		const priorSuccess = history.find(
			(ep) => ep.outcome === "success" && ep.taskDescription === taskDescription,
		);

		if (priorSuccess) {
			const daysAgo = Math.floor(
				(Date.now() - priorSuccess.timestamp) / 86_400_000,
			);
			return `REGRESSION: Previously succeeded at "${taskDescription}" (${daysAgo}d ago)`;
		}
		return null;
	}

	/**
	 * Distill a trace's events into a structured Episode record.
	 * @param agentName - the agent who generated this trace
	 * @param events - the events from the trace, in order
	 */
	distill(agentName: string, events: AgentEvent[]): Episode {
		// --- Task description ---
		const startEvent = events.find((e) => e.type === "session:start");
		const taskDescription =
			(startEvent?.payload.task as string | undefined) ??
			(startEvent?.payload.message as string | undefined) ??
			(startEvent?.payload.prompt as string | undefined) ??
			"Unknown task";

		// --- Outcome ---
		const hasError = events.some((e) => e.type === "agent:error");
		const hasCompletion = events.some((e) => e.type === "agent:completion");
		const sessionEnd = events.find((e) => e.type === "session:end");
		const sessionSuccess = sessionEnd?.payload.success === true;
		const sessionFailure = sessionEnd?.payload.success === false;
		let outcome: EpisodeOutcome;
		if (hasError || sessionFailure) {
			outcome = "failure";
		} else if (hasCompletion || sessionSuccess) {
			outcome = "success";
		} else {
			outcome = "partial";
		}

		// --- Tools used ---
		const toolsSet = new Set<string>();
		for (const event of events) {
			if (event.type === "agent:tool_call") {
				const toolName =
					(event.payload.tool as string | undefined) ??
					(event.payload.name as string | undefined) ??
					((event.payload.toolUse as Record<string, unknown> | undefined)
						?.name as string | undefined);
				if (toolName) {
					toolsSet.add(toolName);
				}
			}
		}
		const toolsUsed = Array.from(toolsSet);

		// --- Turn count ---
		const turnCount = events.filter((e) => e.type === "agent:message").length;

		// --- Duration ---
		const durationMs =
			events.length >= 2
				? events[events.length - 1].timestamp - events[0].timestamp
				: 0;

		// --- Cost ---
		const endEvent = events.find((e) => e.type === "session:end");
		const completionEvent = events.find((e) => e.type === "agent:completion");
		const costUsd =
			(endEvent?.payload.totalCostUsd as number | undefined) ??
			(endEvent?.payload.cost as number | undefined) ??
			(completionEvent?.payload.cost as number | undefined);

		// --- Tool-pair extraction for lessons/strategies/patterns ---
		const pairs = this.extractToolPairs(events);
		const lessonsLearned = this.generateLessons(pairs);
		const effectiveStrategies = this.detectStrategies(pairs);
		const failurePatterns = this.detectFailurePatterns(pairs, events);

		// Efficiency heuristic: fast successful completions with no tool lessons
		if (outcome === "success" && turnCount < 5 && lessonsLearned.length === 0) {
			effectiveStrategies.push("Completed efficiently in few turns");
		}

		// --- Regression detection ---
		const regressionFlag = this.checkRegression(agentName, taskDescription, outcome);
		if (regressionFlag) {
			failurePatterns.unshift(regressionFlag);
		}

		// --- Tags ---
		const tags = [agentName, outcome, ...toolsUsed];

		return {
			id: nanoid(),
			agentName,
			timestamp: Date.now(),
			taskDescription,
			outcome,
			lessonsLearned,
			effectiveStrategies,
			failurePatterns,
			toolsUsed,
			turnCount,
			costUsd,
			durationMs,
			tags,
			utilityScore: 0,
			retrievalCount: 0,
		};
	}

	/**
	 * Extract matched tool call/result pairs from events.
	 * Handles both new format (separate tool_result events) and old format
	 * (nested toolUse, no tool_result events).
	 */
	private extractToolPairs(events: AgentEvent[]): ToolPair[] {
		const pairs: ToolPair[] = [];

		for (let i = 0; i < events.length; i++) {
			const event = events[i];
			if (event.type !== "agent:tool_call") continue;

			// Read tool name: new format uses payload.tool, old format nests under toolUse
			const toolName =
				(event.payload.tool as string | undefined) ??
				((event.payload.toolUse as Record<string, unknown> | undefined)
					?.name as string | undefined);
			if (!toolName) continue;

			// Read input: new format uses payload.input, old format nests under toolUse
			const input =
				(event.payload.input as Record<string, unknown> | undefined) ??
				((event.payload.toolUse as Record<string, unknown> | undefined)
					?.input as Record<string, unknown> | undefined) ??
				{};

			// Look ahead for a matching tool_result event
			let matched = false;
			for (let j = i + 1; j < events.length; j++) {
				const candidate = events[j];
				if (candidate.type === "agent:tool_result" && candidate.payload.tool === toolName) {
					pairs.push({
						tool: toolName,
						input,
						result: candidate.payload.result as string | undefined,
						success: candidate.payload.success !== false,
						error: candidate.payload.error as string | undefined,
					});
					matched = true;
					break;
				}
			}

			// Old format: no tool_result event found
			if (!matched) {
				pairs.push({
					tool: toolName,
					input,
					success: true, // assume success for old traces without result events
				});
			}
		}

		return pairs;
	}

	/**
	 * Generate lesson strings from tool pairs.
	 * Failed tools produce error lessons; successful tools produce call summaries.
	 */
	private generateLessons(pairs: ToolPair[]): string[] {
		const lessons: string[] = [];

		for (const pair of pairs) {
			if (!pair.success) {
				lessons.push(`${pair.tool} failed: ${pair.error ?? "unknown error"}`);
			} else if (pair.result) {
				const truncated =
					pair.result.length > 150
						? pair.result.slice(0, 150) + "..."
						: pair.result;
				lessons.push(`Called ${pair.tool} -> ${truncated}`);
			} else {
				// Old format or no result available
				lessons.push(`Used ${pair.tool}`);
			}
		}

		return lessons;
	}

	/**
	 * Detect effective tool sequences (3+ consecutive successful pairs).
	 */
	private detectStrategies(pairs: ToolPair[]): string[] {
		const strategies: string[] = [];
		let streak: string[] = [];

		for (const pair of pairs) {
			if (pair.success) {
				streak.push(pair.tool);
			} else {
				if (streak.length >= 3) {
					strategies.push(`Effective sequence: ${streak.join(" -> ")}`);
				}
				streak = [];
			}
		}

		// Check final streak
		if (streak.length >= 3) {
			strategies.push(`Effective sequence: ${streak.join(" -> ")}`);
		}

		return strategies;
	}

	/**
	 * Detect failure patterns from failed tool pairs and agent:error events.
	 */
	private detectFailurePatterns(
		pairs: ToolPair[],
		events: AgentEvent[],
	): string[] {
		const patternsSet = new Set<string>();

		// Collect from failed tool pairs
		for (const pair of pairs) {
			if (!pair.success && pair.error) {
				patternsSet.add(pair.error);
			}
		}

		// Collect from agent:error events
		for (const event of events) {
			if (event.type === "agent:error") {
				const errorMsg = event.payload.error as string | undefined;
				if (errorMsg) {
					patternsSet.add(errorMsg);
				}
			}
		}

		return Array.from(patternsSet);
	}
}
