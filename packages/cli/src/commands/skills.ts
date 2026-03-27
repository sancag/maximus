import { Command } from "commander";
import { apiGet } from "../lib/api-client.js";
import { createTable, warn } from "../lib/output.js";
import { handleCommandError } from "../lib/errors.js";

export function registerSkillsCommand(parent: Command): void {
	const skills = parent
		.command("skills")
		.description("Inspect skill definitions")
		.addHelpText(
			"after",
			"\nExample:\n  $ maximus skills list\n  $ maximus skills list --json",
		);

	skills
		.command("list")
		.description("List all skill definitions")
		.addHelpText(
			"after",
			"\nExample:\n  $ maximus skills list\n  $ maximus skills list --json",
		)
		.option("--json", "Output as JSON")
		.action(async (opts) => {
			try {
				const { skills } = await apiGet<{
					skills: Array<{
						name: string;
						description: string;
						toolCount: number;
						credentials: string[];
					}>;
				}>("/api/skills");

				if (skills.length === 0) {
					warn("No skills loaded on server");
					return;
				}

				if (opts.json) {
					console.log(JSON.stringify(skills, null, 2));
					return;
				}

				const table = createTable([
					"Name",
					"Description",
					"Tools",
					"Credentials",
				]);
				for (const s of skills) {
					table.push([
						s.name,
						s.description,
						String(s.toolCount),
						s.credentials.join(", ") || "-",
					]);
				}
				console.log(table.toString());
			} catch (err) {
				handleCommandError(err);
			}
		});
}
