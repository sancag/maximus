import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { skillSchema, type SkillDefinition } from "@maximus/shared";

/**
 * Load and parse a single YAML skill definition file.
 * Validates content using the shared Zod schema.
 */
export function loadSkillDefinition(filepath: string): SkillDefinition {
	const raw = fs.readFileSync(filepath, "utf-8");
	const parsed = YAML.parse(raw);
	return skillSchema.parse(parsed);
}

/**
 * Load all .yaml/.yml skill definitions from a directory.
 */
export function loadSkillsFromDirectory(dirPath: string): SkillDefinition[] {
	const files = fs
		.readdirSync(dirPath)
		.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
	return files.map((f) => loadSkillDefinition(path.join(dirPath, f)));
}
