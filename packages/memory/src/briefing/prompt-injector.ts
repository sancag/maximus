import type { BriefingGenerator } from "./briefing-generator.js";
import type { MemoryConfig } from "@maximus/shared";

/**
 * Injects briefings into agent system prompts.
 * Returns original prompt if briefing is disabled or empty.
 * IMPORTANT: Does NOT mutate agentDef -- returns a new string.
 */
export class PromptInjector {
	constructor(private briefingGenerator: BriefingGenerator) {}

	/**
	 * Generate and prepend briefing to the agent's system prompt.
	 * Returns the original prompt unchanged if briefing is disabled or empty.
	 */
	async inject(
		agentName: string,
		originalPrompt: string,
		memoryConfig: MemoryConfig | undefined,
		teamMembers: string[],
	): Promise<string> {
		// Skip if briefing is disabled (default is true per schema)
		if (memoryConfig?.briefingEnabled === false) {
			return originalPrompt;
		}

		const tokenBudget = memoryConfig?.briefingTokenBudget ?? 2000;
		const briefing = await this.briefingGenerator.generate(
			agentName,
			teamMembers,
			tokenBudget,
		);

		if (!briefing) {
			return originalPrompt;
		}

		// Prepend briefing to prompt -- creates new string, never mutates agentDef
		return briefing + "\n\n" + originalPrompt;
	}
}
