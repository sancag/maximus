import { Command } from "commander";
import { apiGet, apiPost } from "../lib/api-client.js";
import { createTable, warn } from "../lib/output.js";
import { handleCommandError } from "../lib/errors.js";
import chalk from "chalk";
import type { MemoryStatusResponse, AgentMemoryResponse, PromoteRequest, PromoteResponse, PipelineResult } from "@maximus/shared";

export function registerMemoryCommand(parent: Command): void {
	const memory = parent.command("memory").description("Inspect and manage agent memory");

	memory
		.command("status")
		.description("Show memory system status")
		.addHelpText("after", "\nExample:\n  $ maximus memory status\n  $ maximus memory status --json")
		.option("--json", "Output as JSON")
		.action(async (opts) => {
			try {
				const data = await apiGet<MemoryStatusResponse>("/api/memory/status");

				if (opts.json) {
					console.log(JSON.stringify(data, null, 2));
					return;
				}

				// Knowledge Graph section
				console.log(chalk.bold("Knowledge Graph"));
				console.log(`  Entities:  ${data.graph.entityCount}`);
				console.log(`  Triples:   ${data.graph.tripleCount}  (agent: ${data.graph.scopeCounts.agent}, team: ${data.graph.scopeCounts.team}, global: ${data.graph.scopeCounts.global})`);
				console.log();

				// Episodes section
				console.log(chalk.bold("Episodes"));
				console.log(`  Total: ${data.episodes.total}`);
				if (data.episodes.byAgent.length === 0) {
					warn("No episodes recorded yet");
				} else {
					for (const agent of data.episodes.byAgent) {
						console.log(`    ${agent.agentName.padEnd(15)} ${agent.count}`);
					}
				}
				console.log();

				// Last Consolidation
				const lastConsolidation = data.lastConsolidation
					? new Date(data.lastConsolidation).toLocaleString()
					: "Never";
				console.log(`Last Consolidation: ${lastConsolidation}`);
			} catch (err) {
				handleCommandError(err);
			}
		});

	memory
		.command("inspect <agent>")
		.description("Show agent episodes, briefing, and knowledge")
		.addHelpText("after", "\nExample:\n  $ maximus memory inspect researcher\n  $ maximus memory inspect coder --json")
		.option("--json", "Output as JSON")
		.action(async (agent: string, opts) => {
			try {
				const data = await apiGet<AgentMemoryResponse>(`/api/memory/inspect/${agent}`);

				if (opts.json) {
					console.log(JSON.stringify(data, null, 2));
					return;
				}

				// Check if there's any data
				const hasData = data.episodes.length > 0 ||
					data.briefing !== null ||
					data.knowledge.length > 0 ||
					data.metrics.length > 0;

				if (!hasData) {
					warn("No memory data for agent: " + agent);
					return;
				}

				// Episodes section
				if (data.episodes.length > 0) {
					console.log(chalk.bold("Episodes"));
					const table = createTable(["Date", "Task", "Outcome", "Lessons"]);
					for (const episode of data.episodes.slice(0, 20)) {
						const date = new Date(episode.timestamp).toLocaleDateString();
						const task = episode.taskDescription.length > 40
							? episode.taskDescription.slice(0, 37) + "..."
							: episode.taskDescription;
						const lessons = episode.lessonsLearned.length > 0
							? `${episode.lessonsLearned.length} lesson(s)`
							: "-";
						table.push([date, task, episode.outcome, lessons]);
					}
					console.log(table.toString());
					if (data.episodes.length > 20) {
						console.log(chalk.dim(`  ... and ${data.episodes.length - 20} more episodes`));
					}
					console.log();
				}

				// Briefing section
				console.log(chalk.bold("Active Briefing"));
				if (data.briefing) {
					console.log(data.briefing.content);
				} else {
					console.log(chalk.dim("No briefing generated yet"));
				}
				console.log();

				// Knowledge section
				if (data.knowledge.length > 0) {
					console.log(chalk.bold("Knowledge"));
					const table = createTable(["Source", "Predicate", "Target", "Scope", "Confidence"]);
					for (const item of data.knowledge) {
						table.push([
							item.entity.name,
							item.triple.predicate,
							item.target.name,
							item.triple.scope,
							item.triple.confidence.toFixed(2),
						]);
					}
					console.log(table.toString());
					console.log();
				}

				// Metrics section
				if (data.metrics.length > 0) {
					console.log(chalk.bold("Metrics"));
					const latest = data.metrics[data.metrics.length - 1];
					console.log(`  Success Rate:  ${latest.successRate?.toFixed(2) ?? "-"}`);
					console.log(`  Avg Turns:     ${latest.avgTurns?.toFixed(1) ?? "-"}`);
					console.log(`  Avg Cost:      ${latest.avgCostUsd ? `$${latest.avgCostUsd.toFixed(4)}` : "-"}`);
					console.log(`  Total Sessions: ${latest.totalSessions}`);
					console.log();
				}
			} catch (err) {
				handleCommandError(err);
			}
		});

	memory
		.command("promote <sourceId> <predicate> <targetId>")
		.description("Promote a knowledge triple to a higher scope")
		.addHelpText("after", "\nExample:\n  $ maximus memory promote entity-123 knows entity-456")
		.action(async (sourceId: string, predicate: string, targetId: string) => {
			try {
				const result = await apiPost<PromoteRequest, PromoteResponse>("/api/memory/promote", {
					sourceId,
					predicate,
					targetId,
				});

				if (result.promoted) {
					console.log(chalk.green("Promoted") + ` from ${result.from} to ${result.to}`);
				} else {
					console.log(chalk.yellow(result.message));
				}
			} catch (err) {
				handleCommandError(err);
			}
		});

	memory
		.command("re-extract")
		.description("Flush all extracted data and reprocess traces with current pipeline")
		.option("--yes", "Skip confirmation prompt")
		.action(async (opts) => {
			try {
				if (!opts.yes) {
					const readline = await import("node:readline");
					const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
					const answer = await new Promise<string>((resolve) => {
						rl.question(chalk.yellow("This will flush all episodes, entities, triples, briefings, and metrics, then reprocess all traces. Continue? [y/N] "), resolve);
					});
					rl.close();
					if (answer.toLowerCase() !== "y") {
						console.log("Cancelled.");
						return;
					}
				}

				console.log(chalk.blue("Flushing extracted data..."));
				const result = await apiPost<Record<string, never>, { success: boolean; result?: PipelineResult }>("/api/memory/re-extract", {});
				if (result.success) {
					console.log(chalk.green("Re-extraction complete."));
					if (result.result) {
						console.log(`  Episodes created: ${result.result.episodesCreated ?? 0}`);
						console.log(`  Entities extracted: ${result.result.entitiesExtracted ?? 0}`);
						console.log(`  Triples extracted: ${result.result.triplesExtracted ?? 0}`);
						console.log(`  Metrics computed: ${result.result.metricsComputed ?? 0}`);
					}
				} else {
					warn("Re-extraction failed");
				}
			} catch (err) {
				handleCommandError(err);
			}
		});

	memory
		.command("reset")
		.description("Delete all traces and flush all memory data (DESTRUCTIVE)")
		.option("--yes", "Skip confirmation prompt")
		.action(async (opts) => {
			try {
				if (!opts.yes) {
					const readline = await import("node:readline");
					const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
					const answer = await new Promise<string>((resolve) => {
						rl.question(chalk.red("WARNING: This will delete ALL trace files and flush ALL memory data. This cannot be undone. Continue? [y/N] "), resolve);
					});
					rl.close();
					if (answer.toLowerCase() !== "y") {
						console.log("Cancelled.");
						return;
					}
				}

				console.log(chalk.blue("Resetting memory system..."));
				const result = await apiPost<Record<string, never>, { success: boolean }>("/api/memory/reset", {});
				if (result.success) {
					console.log(chalk.green("Memory system reset complete. All data cleared."));
				} else {
					warn("Reset failed");
				}
			} catch (err) {
				handleCommandError(err);
			}
		});
}
