import { Command } from "commander";
import { apiGet } from "../lib/api-client.js";
import { createTable, warn } from "../lib/output.js";
import { handleCommandError } from "../lib/errors.js";
import chalk from "chalk";

export function registerAgentsCommand(parent: Command): void {
	const agents = parent
		.command("agents")
		.description("Inspect agent definitions")
		.addHelpText("after", "\nExample:\n  $ maximus agents list");

	agents
		.command("list")
		.description("List all agent definitions")
		.addHelpText(
			"after",
			"\nExample:\n  $ maximus agents list\n  $ maximus agents list --json",
		)
		.option("--json", "Output as JSON")
		.action(async (opts) => {
			try {
				const { agents } = await apiGet<{
					agents: Array<{
						name: string;
						description: string;
						model: string;
						skills: string[];
						reportsTo: string | null;
					}>;
				}>("/api/agents");

				if (agents.length === 0) {
					warn("No agents loaded on server");
					return;
				}

				if (opts.json) {
					console.log(JSON.stringify(agents, null, 2));
					return;
				}

				const table = createTable([
					"Name",
					"Description",
					"Model",
					"Skills",
					"Reports To",
				]);
				for (const a of agents) {
					table.push([
						a.name,
						a.description,
						a.model,
						String(a.skills.length),
						a.reportsTo ?? "-",
					]);
				}
				console.log(table.toString());
			} catch (err) {
				handleCommandError(err);
			}
		});

	agents
		.command("org-chart")
		.description("Display agent hierarchy as a tree")
		.addHelpText("after", "\nExample:\n  $ maximus agents org-chart")
		.action(async () => {
			try {
				const { agents: orgData } = await apiGet<{
					agents: Array<{
						name: string;
						reportsTo: string | null;
					}>;
				}>("/api/agents/org-chart");

				if (orgData.length === 0) {
					warn("No agents loaded on server");
					return;
				}

				// Build tree from flat list
				interface OrgNode {
					name: string;
					children: OrgNode[];
				}
				const nodeMap = new Map<string, OrgNode>();
				for (const a of orgData) {
					nodeMap.set(a.name, { name: a.name, children: [] });
				}

				const roots: OrgNode[] = [];
				for (const a of orgData) {
					const node = nodeMap.get(a.name)!;
					if (a.reportsTo && nodeMap.has(a.reportsTo)) {
						nodeMap.get(a.reportsTo)!.children.push(node);
					} else {
						roots.push(node);
					}
				}

				// Render tree with box-drawing characters
				function renderTree(nodes: OrgNode[], prefix = ""): string {
					let out = "";
					for (let i = 0; i < nodes.length; i++) {
						const isLast = i === nodes.length - 1;
						const connector = isLast
							? "\u2514\u2500\u2500 "
							: "\u251C\u2500\u2500 ";
						const childPrefix = isLast ? "    " : "\u2502   ";
						out +=
							prefix +
							connector +
							chalk.bold(nodes[i].name) +
							"\n";
						out += renderTree(
							nodes[i].children,
							prefix + childPrefix,
						);
					}
					return out;
				}

				// Print roots
				for (const root of roots) {
					console.log(chalk.bold(root.name));
					console.log(renderTree(root.children));
				}
			} catch (err) {
				handleCommandError(err);
			}
		});
}
