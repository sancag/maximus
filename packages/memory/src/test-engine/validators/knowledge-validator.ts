import {
  knowledgeEntitySchema,
  knowledgeTripleSchema,
  type KnowledgeEntity,
  type KnowledgeTriple,
} from "@maximus/shared";

export interface KnowledgeValidationResult {
  valid: boolean;
  entityErrors: string[];
  tripleErrors: string[];
  entities?: KnowledgeEntity[];
  triples?: KnowledgeTriple[];
}

export interface KnowledgeValidationOptions {
  expectEntities?: number;
  expectTriples?: number;
  checkEntityTypes?: string[];
}

export class KnowledgeValidator {
  validate(
    entities: unknown[],
    triples: unknown[],
    options: KnowledgeValidationOptions = {}
  ): KnowledgeValidationResult {
    const entityErrors: string[] = [];
    const tripleErrors: string[] = [];
    const validEntities: KnowledgeEntity[] = [];
    const validTriples: KnowledgeTriple[] = [];

    // Validate entities
    for (let i = 0; i < entities.length; i++) {
      const parseResult = knowledgeEntitySchema.safeParse(entities[i]);
      if (!parseResult.success) {
        entityErrors.push(
          `Entity ${i}: ${parseResult.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`
        );
      } else {
        validEntities.push(parseResult.data);
      }
    }

    // Validate triples
    for (let i = 0; i < triples.length; i++) {
      const parseResult = knowledgeTripleSchema.safeParse(triples[i]);
      if (!parseResult.success) {
        tripleErrors.push(
          `Triple ${i}: ${parseResult.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`
        );
      } else {
        validTriples.push(parseResult.data);
      }
    }

    // Option-based validation
    if (options.expectEntities !== undefined) {
      if (validEntities.length !== options.expectEntities) {
        entityErrors.push(
          `Expected ${options.expectEntities} valid entities, got ${validEntities.length}`
        );
      }
    }

    if (options.expectTriples !== undefined) {
      if (validTriples.length !== options.expectTriples) {
        tripleErrors.push(
          `Expected ${options.expectTriples} valid triples, got ${validTriples.length}`
        );
      }
    }

    if (options.checkEntityTypes) {
      for (const type of options.checkEntityTypes) {
        const hasType = validEntities.some((e) => e.type === type);
        if (!hasType) {
          entityErrors.push(`Expected at least one entity of type "${type}"`);
        }
      }
    }

    return {
      valid: entityErrors.length === 0 && tripleErrors.length === 0,
      entityErrors,
      tripleErrors,
      entities: validEntities,
      triples: validTriples,
    };
  }
}
