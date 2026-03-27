import { AgentRegistry } from "../agents/registry.js";
import { loadSkillsFromDirectory } from "../skills/loader.js";
import { composeSkillToMcpServer } from "../skills/composer.js";
import { createDelegationMcpServer } from "../delegation/delegate-tool.js";
import { EventBus } from "../events/bus.js";
import { AgentSession } from "./session.js";
import type { EngineConfig, SessionConfig, SessionResult } from "./types.js";
import { CredentialVault, CredentialProxy } from "@maximus/vault";
import type { SkillDefinition } from "@maximus/shared";
import { TaskStore } from "../tasks/store.js";
import { BudgetTracker } from "../tasks/budget.js";
import { Delegator } from "../delegation/delegator.js";
import { AgentLock } from "../delegation/lock.js";
import { Messenger } from "../delegation/messenger.js";
import { SessionManager } from "./session-manager.js";
import {
	PromptInjector,
	BriefingGenerator,
	BriefingStore,
	KnowledgeStore,
	EpisodeStore,
	MemoryEngine,
} from "@maximus/memory";
import pino from "pino";
import * as readline from "node:readline";

export class AgentEngine {
	private agentRegistry: AgentRegistry;
	private skillRegistry = new Map<string, SkillDefinition>();
	private eventBus: EventBus;
	private credentialProxy: CredentialProxy | null = null;
	private activeSessions = new Map<string, AgentSession>();
	private logger = pino({ name: "maximus-engine" });
	private taskStore: TaskStore;
	private budgetTracker: BudgetTracker;
	private delegator!: Delegator;
	private agentLock: AgentLock;
	private messenger!: Messenger;
	private sessionManager: SessionManager;
	private memoryEngine: MemoryEngine | null = null;
	private promptInjector: PromptInjector | null = null;

	constructor(private config: EngineConfig) {
		this.agentRegistry = new AgentRegistry();
		this.eventBus = new EventBus();
		this.taskStore = new TaskStore({ tasksPath: config.tasksPath });
		this.budgetTracker = new BudgetTracker();
		this.agentLock = new AgentLock();
		this.sessionManager = new SessionManager(this);
	}

	async initialize(): Promise<void> {
		// Load agent definitions from directory
		this.agentRegistry.loadFromDirectory(this.config.agentsDir);
		this.logger.info(
			{ count: this.agentRegistry.getAll().length },
			"Agents loaded",
		);

		// Load skill definitions from directory
		const skills = loadSkillsFromDirectory(this.config.skillsDir);
		for (const skill of skills) {
			this.skillRegistry.set(skill.name, skill);
		}
		this.logger.info({ count: this.skillRegistry.size }, "Skills loaded");

		// Resolve vault key: config > env var > interactive prompt (per locked decision)
		let vaultKey = this.config.vaultKey ?? process.env.MAXIMUS_VAULT_KEY;

		if (!vaultKey && process.stdin.isTTY) {
			// Falls back to interactive prompt if env var missing (for local development)
			// Per CONTEXT.md locked decision: "Falls back to interactive prompt if env var missing"
			vaultKey = await this.promptForVaultKey();
		}

		// Initialize credential vault if we have a key from any source
		if (vaultKey) {
			let vault: CredentialVault;
			if (this.config.vaultPath) {
				const { existsSync } = await import("node:fs");
				vault = existsSync(this.config.vaultPath)
					? CredentialVault.load(this.config.vaultPath, vaultKey)
					: new CredentialVault(vaultKey);
			} else {
				vault = new CredentialVault(vaultKey);
			}
			this.credentialProxy = new CredentialProxy(vault);
			this.logger.info("Credential vault initialized");
		} else {
			this.logger.warn(
				"No vault key provided — credential resolution will fail for tools that require it",
			);
		}

		// Initialize delegation subsystem
		this.delegator = new Delegator(
			this,
			this.taskStore,
			this.budgetTracker,
			this.agentLock,
			this.eventBus,
			this.agentRegistry,
		);
		this.messenger = new Messenger(this.agentRegistry, this.eventBus);

		// Initialize memory system if memoryDir is configured
		if (this.config.memoryDir) {
			this.memoryEngine = new MemoryEngine(this.config.memoryDir);
			const sqlite = this.memoryEngine.getSqlite();
			const kuzu = await this.memoryEngine.getKuzu();
			const episodeStore = new EpisodeStore(sqlite.raw);
			const knowledgeStore = await KnowledgeStore.create(kuzu);
			const briefingStore = new BriefingStore(sqlite.raw);
			const briefingGenerator = new BriefingGenerator(
				episodeStore,
				knowledgeStore,
				briefingStore,
			);
			this.promptInjector = new PromptInjector(briefingGenerator);
			this.logger.info("Memory system initialized");
		}
	}

	private promptForVaultKey(): Promise<string | undefined> {
		return new Promise((resolve) => {
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stderr, // Use stderr so prompts don't mix with stdout output
			});
			rl.question(
				"Enter vault key (MAXIMUS_VAULT_KEY): ",
				(answer) => {
					rl.close();
					resolve(answer.trim() || undefined);
				},
			);
		});
	}

	async runAgent(config: SessionConfig): Promise<SessionResult> {
		// Re-read agent/skill files so new definitions are picked up without restart
		this.agentRegistry.refresh();
		this.refreshSkills();

		const agentDef = this.agentRegistry.get(config.agentName);

		// Compose MCP servers from agent's skills
		const mcpServers: Record<string, any> = {};
		for (const skillName of agentDef.skills) {
			const skill = this.skillRegistry.get(skillName);
			if (!skill) {
				this.logger.warn(
					{ skill: skillName, agent: config.agentName },
					"Skill not found",
				);
				continue;
			}
			// Use credential proxy if available, otherwise a stub that throws
			const resolver = this.credentialProxy ?? {
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

		// If this agent has sub-agents, inject delegate + check_task tools
		const reports = this.agentRegistry.getReports(agentDef.name);
		if (reports.length > 0) {
			mcpServers["__delegation"] = await createDelegationMcpServer(
				agentDef.name,
				this.agentRegistry,
				this,
				this.taskStore,
			);
		}

		// Inject briefing into system prompt if memory is enabled
		let systemPrompt = agentDef.prompt;
		if (this.promptInjector && agentDef.memory) {
			const teamMembers = this.agentRegistry
				.getAll()
				.filter(
					(a) =>
						a.reportsTo === agentDef.reportsTo &&
						a.name !== agentDef.name,
				)
				.map((a) => a.name);
			systemPrompt = await this.promptInjector.inject(
				agentDef.name,
				agentDef.prompt,
				agentDef.memory,
				teamMembers,
			);
		}

		// Create a shallow copy with injected prompt -- NEVER mutate the registry's agentDef (Pitfall 6)
		const sessionAgentDef =
			systemPrompt !== agentDef.prompt
				? { ...agentDef, prompt: systemPrompt }
				: agentDef;

		const session = new AgentSession(
			sessionAgentDef,
			mcpServers,
			this.eventBus,
			config,
		);
		this.activeSessions.set(session.getSessionId(), session);

		try {
			const result = await session.run();
			return result;
		} finally {
			this.activeSessions.delete(session.getSessionId());
		}
	}

	private refreshSkills(): void {
		if (!this.config.skillsDir) return;
		this.skillRegistry.clear();
		const skills = loadSkillsFromDirectory(this.config.skillsDir);
		for (const skill of skills) {
			this.skillRegistry.set(skill.name, skill);
		}
	}

	getEventBus(): EventBus {
		return this.eventBus;
	}

	getAgentRegistry(): AgentRegistry {
		return this.agentRegistry;
	}

	getSkillRegistry(): Map<string, SkillDefinition> {
		return this.skillRegistry;
	}

	getTaskStore(): TaskStore {
		return this.taskStore;
	}

	getDelegator(): Delegator {
		return this.delegator;
	}

	getMessenger(): Messenger {
		return this.messenger;
	}

	getBudgetTracker(): BudgetTracker {
		return this.budgetTracker;
	}

	getSessionManager(): SessionManager {
		return this.sessionManager;
	}

	getCredentialProxy(): CredentialProxy | null {
		return this.credentialProxy;
	}

	async shutdown(): Promise<void> {
		// Close persistent session first
		await this.sessionManager.closeSession();

		// Abort all active one-shot sessions
		for (const [id, session] of this.activeSessions) {
			session.abort();
		}
		this.activeSessions.clear();
		this.eventBus.removeAllListeners();

		// Close memory engine if initialized
		if (this.memoryEngine) {
			await this.memoryEngine.close();
		}

		this.logger.info("Engine shut down");
	}
}
