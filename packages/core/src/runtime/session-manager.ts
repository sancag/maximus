import type { AgentEngine } from "./engine.js";
import { PersistentSession } from "./persistent-session.js";
import { composeSkillToMcpServer } from "../skills/composer.js";
import { createDelegationMcpServer } from "../delegation/delegate-tool.js";

/**
 * SessionManager manages the singleton orchestrator PersistentSession.
 * Lazily creates the session on first use and reuses it across messages.
 * Handles cleanup on engine shutdown.
 */
export class SessionManager {
	private activeSession: PersistentSession | null = null;

	constructor(
		private engine: Pick<
			AgentEngine,
			| "getAgentRegistry"
			| "getSkillRegistry"
			| "getEventBus"
			| "getCredentialProxy"
			| "getTaskStore"
			| "runAgent"
		>,
	) {}

	async getOrCreateSession(): Promise<PersistentSession> {
		if (this.activeSession && this.activeSession.isActive()) {
			return this.activeSession;
		}

		// Find orchestrator: root agent with no reportsTo
		const registry = this.engine.getAgentRegistry();
		const allAgents = registry.getAll();
		const orchestrator = allAgents.find((a) => !a.reportsTo);

		if (!orchestrator) {
			throw new Error(
				"No orchestrator agent found (agent with no reportsTo)",
			);
		}

		// Compose MCP servers from agent skills (same pattern as engine.runAgent)
		const mcpServers: Record<string, any> = {};
		const skillRegistry = this.engine.getSkillRegistry();

		for (const skillName of orchestrator.skills) {
			const skill = skillRegistry.get(skillName);
			if (!skill) continue;

			const resolver = this.engine.getCredentialProxy() ?? {
				resolve: async (name: string) => {
					throw new Error(
						`No credential vault configured. Cannot resolve: ${name}`,
					);
				},
			};
			mcpServers[skill.name] = await composeSkillToMcpServer(
				skill,
				resolver,
			);
		}

		// If orchestrator has sub-agents, inject delegate + check_task tools
		const reports = registry.getReports(orchestrator.name);
		if (reports.length > 0) {
			mcpServers["__delegation"] = await createDelegationMcpServer(
				orchestrator.name,
				registry,
				this.engine,
				this.engine.getTaskStore(),
			);
		}

		// Create and start the persistent session
		const eventBus = this.engine.getEventBus();
		const session = new PersistentSession(
			orchestrator,
			mcpServers,
			eventBus,
			{
				agentName: orchestrator.name,
				maxTurns: orchestrator.maxTurns,
			},
		);

		await session.start();
		this.activeSession = session;
		return session;
	}

	async closeSession(): Promise<void> {
		if (this.activeSession) {
			await this.activeSession.close();
			this.activeSession = null;
		}
	}

	hasActiveSession(): boolean {
		return this.activeSession !== null && this.activeSession.isActive();
	}
}
