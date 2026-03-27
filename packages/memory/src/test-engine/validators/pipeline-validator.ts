import { pipelineResultSchema, type PipelineResult } from "@maximus/shared";

export interface PipelineValidationResult {
  valid: boolean;
  errors: string[];
  result?: PipelineResult;
}

export interface PipelineValidationOptions {
  expectTracesProcessed?: number;
  expectEpisodesCreated?: number;
  expectNoErrors?: boolean;
  expectBriefingsGenerated?: number;
}

export class PipelineValidator {
  validate(result: unknown, options: PipelineValidationOptions = {}): PipelineValidationResult {
    const errors: string[] = [];

    // Schema validation
    const parseResult = pipelineResultSchema.safeParse(result);
    if (!parseResult.success) {
      errors.push(...parseResult.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`));
      return { valid: false, errors };
    }

    const validResult = parseResult.data;

    // Option-based validation
    if (options.expectTracesProcessed !== undefined) {
      if (validResult.tracesProcessed !== options.expectTracesProcessed) {
        errors.push(
          `Expected ${options.expectTracesProcessed} traces processed, got ${validResult.tracesProcessed}`
        );
      }
    }

    if (options.expectEpisodesCreated !== undefined) {
      if (validResult.episodesCreated !== options.expectEpisodesCreated) {
        errors.push(
          `Expected ${options.expectEpisodesCreated} episodes created, got ${validResult.episodesCreated}`
        );
      }
    }

    if (options.expectNoErrors) {
      if (validResult.stageErrors.length > 0) {
        errors.push(
          `Expected no stage errors, got: ${validResult.stageErrors.map((e) => `${e.stage}: ${e.error}`).join(", ")}`
        );
      }
    }

    if (options.expectBriefingsGenerated !== undefined) {
      if (validResult.briefingsGenerated !== options.expectBriefingsGenerated) {
        errors.push(
          `Expected ${options.expectBriefingsGenerated} briefings generated, got ${validResult.briefingsGenerated}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      result: validResult,
    };
  }
}
