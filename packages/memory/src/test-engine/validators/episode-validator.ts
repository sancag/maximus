import { episodeSchema, type Episode } from "@maximus/shared";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  episode?: Episode;
}

export interface ValidationOptions {
  checkOutcome?: boolean;
  expectedOutcome?: "success" | "failure" | "partial";
  checkAgentName?: boolean;
  expectedAgentName?: string;
  checkToolsUsed?: boolean;
  expectedTools?: string[];
}

export class EpisodeValidator {
  validate(episode: unknown, options: ValidationOptions = {}): ValidationResult {
    const errors: string[] = [];

    // Schema validation
    const parseResult = episodeSchema.safeParse(episode);
    if (!parseResult.success) {
      errors.push(...parseResult.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`));
      return { valid: false, errors };
    }

    const validEpisode = parseResult.data;

    // Option-based validation
    if (options.checkOutcome && options.expectedOutcome) {
      if (validEpisode.outcome !== options.expectedOutcome) {
        errors.push(`Expected outcome "${options.expectedOutcome}", got "${validEpisode.outcome}"`);
      }
    }

    if (options.checkAgentName && options.expectedAgentName) {
      if (validEpisode.agentName !== options.expectedAgentName) {
        errors.push(`Expected agent "${options.expectedAgentName}", got "${validEpisode.agentName}"`);
      }
    }

    if (options.checkToolsUsed && options.expectedTools) {
      for (const tool of options.expectedTools) {
        if (!validEpisode.toolsUsed.includes(tool)) {
          errors.push(`Expected tool "${tool}" not found in toolsUsed`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      episode: validEpisode,
    };
  }

  validateMany(episodes: unknown[], options: ValidationOptions = {}): ValidationResult[] {
    return episodes.map((ep) => this.validate(ep, options));
  }
}
