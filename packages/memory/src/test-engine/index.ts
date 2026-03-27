export { AgentSimulator } from "./simulator/agent-simulator.js";
export type { SimulationConfig } from "./simulator/agent-simulator.js";

export { TraceGenerator } from "./simulator/trace-generator.js";
export type { TraceWriteOptions } from "./simulator/trace-generator.js";

export { ScenarioGenerator } from "./simulator/scenario-generator.js";
export type { TestScenario } from "./simulator/scenario-generator.js";

export { EpisodeValidator } from "./validators/episode-validator.js";
export type { ValidationResult, ValidationOptions } from "./validators/episode-validator.js";

export { PipelineValidator } from "./validators/pipeline-validator.js";
export type {
  PipelineValidationResult,
  PipelineValidationOptions,
} from "./validators/pipeline-validator.js";

export { KnowledgeValidator } from "./validators/knowledge-validator.js";
export type {
  KnowledgeValidationResult,
  KnowledgeValidationOptions,
} from "./validators/knowledge-validator.js";

export { GapAnalyzer, runGapAnalysis } from "./validators/gap-analyzer.js";
export type { GapFinding, GapReport, GapMetrics } from "./validators/gap-analyzer.js";
