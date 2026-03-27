import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { agentFrontmatterSchema, type AgentDefinition } from "@maximus/shared";

/**
 * Load and parse a single Markdown agent definition file.
 * Validates frontmatter using the shared Zod schema.
 */
export function loadAgentDefinition(filepath: string): AgentDefinition {
	const raw = fs.readFileSync(filepath, "utf-8");
	const { data, content } = matter(raw);
	const frontmatter = agentFrontmatterSchema.parse(data);

	return {
		...frontmatter,
		prompt: content.trim(),
		filePath: path.resolve(filepath),
	};
}

/**
 * Load all .md agent definitions from a directory.
 */
export function loadAgentsFromDirectory(dirPath: string): AgentDefinition[] {
	const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".md"));
	return files.map((f) => loadAgentDefinition(path.join(dirPath, f)));
}
