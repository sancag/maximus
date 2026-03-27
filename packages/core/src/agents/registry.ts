import type { AgentDefinition } from "@maximus/shared";
import { loadAgentsFromDirectory } from "./loader.js";

export class AgentRegistry {
	private agents = new Map<string, AgentDefinition>();
	private dirPath: string | null = null;

	register(agent: AgentDefinition): void {
		this.agents.set(agent.name, agent);
	}

	get(name: string): AgentDefinition {
		const agent = this.agents.get(name);
		if (!agent) throw new Error(`Agent not found: ${name}`);
		return agent;
	}

	getAll(): AgentDefinition[] {
		return Array.from(this.agents.values());
	}

	has(name: string): boolean {
		return this.agents.has(name);
	}

	loadFromDirectory(dirPath: string): void {
		this.dirPath = dirPath;
		const agents = loadAgentsFromDirectory(dirPath);
		for (const agent of agents) {
			this.register(agent);
		}
	}

	/** Re-read agent files from disk so new/changed agents are picked up without restart */
	refresh(): void {
		if (!this.dirPath) return;
		this.agents.clear();
		const agents = loadAgentsFromDirectory(this.dirPath);
		for (const agent of agents) {
			this.register(agent);
		}
	}

	clear(): void {
		this.agents.clear();
	}

	getReports(agentName: string): AgentDefinition[] {
		return this.getAll().filter((a) => a.reportsTo === agentName);
	}

	canDelegateTo(from: string, to: string): boolean {
		const target = this.agents.get(to);
		if (!target) return false;
		return target.reportsTo === from;
	}

	getOrgChart(): { name: string; reportsTo?: string; description: string }[] {
		return this.getAll().map((a) => ({
			name: a.name,
			reportsTo: a.reportsTo,
			description: a.description,
		}));
	}
}
