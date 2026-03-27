import type { Episode, KnowledgeEntity, KnowledgeTriple, AgentMetrics, Briefing } from "./memory.js";

export interface MemoryStatusResponse {
	graph: {
		entityCount: number;
		tripleCount: number;
		scopeCounts: { agent: number; team: number; global: number };
	};
	episodes: {
		total: number;
		byAgent: Array<{ agentName: string; count: number }>;
	};
	lastConsolidation: number | null;
}

export interface KnowledgeGraphResponse {
	nodes: Array<{
		id: string;
		name: string;
		type: string;
		createdBy: string;
	}>;
	links: Array<{
		source: string;
		target: string;
		predicate: string;
		scope: "agent" | "team" | "global";
		confidence: number;
	}>;
	counts: {
		entities: number;
		triples: number;
	};
}

export interface AgentMemoryResponse {
	agent: string;
	episodes: Episode[];
	briefing: Briefing | null;
	knowledge: Array<{
		entity: KnowledgeEntity;
		triple: KnowledgeTriple;
		target: KnowledgeEntity;
	}>;
	metrics: AgentMetrics[];
}

export interface PromoteRequest {
	sourceId: string;
	predicate: string;
	targetId: string;
}

export interface PromoteResponse {
	promoted: boolean;
	from: string;
	to: string;
	message: string;
}
