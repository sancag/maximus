import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition } from "@maximus/shared";
import type { AgentEvent } from "@maximus/shared";
import type { PersistentSessionConfig } from "./types.js";
import { AsyncChannel } from "./async-channel.js";
import { EventBus } from "../events/bus.js";
import { createHooks, filterEnvForSdk } from "./hooks.js";
import { nanoid } from "nanoid";

/**
 * PersistentSession wraps a long-lived SDK query() call.
 * Instead of a one-shot string prompt, it uses an AsyncChannel
 * to feed SDKUserMessages over time. The query stays alive
 * across multiple user messages, maintaining conversation context.
 */
export class PersistentSession {
	private inputChannel: AsyncChannel<any> | null = null;
	private queryHandle: any = null;
	private abortController: AbortController;
	private sessionId: string;
	private traceId: string;
	private active = false;
	private processOutputPromise: Promise<void> | null = null;

	// Block chunking state (same as AgentSession)
	private textBuffer: string = "";
	private readonly BLOCK_MIN_CHARS = 80;
	private readonly BLOCK_MAX_CHARS = 2000;
	private blockFlushTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly BLOCK_FLUSH_DELAY_MS = 150;

	// Turn completion detection
	private turnIdleTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly TURN_IDLE_MS = 500;
	private inTurn = false;

	constructor(
		private agentDef: AgentDefinition,
		private mcpServers: Record<string, any>,
		private eventBus: EventBus,
		private config: PersistentSessionConfig,
	) {
		this.sessionId = config.sessionId ?? nanoid();
		this.traceId = config.traceId ?? nanoid();
		this.abortController = new AbortController();
	}

	async start(): Promise<void> {
		this.inputChannel = new AsyncChannel();
		const hooks = createHooks(
			this.eventBus,
			this.agentDef.name,
			this.sessionId,
		);

		this.queryHandle = query({
			prompt: this.inputChannel,
			options: {
				systemPrompt: this.agentDef.prompt,
				model: this.agentDef.model ?? "sonnet",
				maxTurns:
					this.config.maxTurns ?? this.agentDef.maxTurns ?? 25,
				mcpServers: this.mcpServers,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				abortController: this.abortController,
				env: filterEnvForSdk(process.env),
				hooks,
			},
		});

		this.active = true;

		this.eventBus.emit({
			id: nanoid(),
			timestamp: Date.now(),
			sessionId: this.sessionId,
			agentName: this.agentDef.name,
			type: "session:start",
			payload: {},
		});

		// Start processing output in the background
		this.processOutputPromise = this.processOutput();
	}

	async send(message: string): Promise<void> {
		if (!this.inputChannel || !this.active) {
			throw new Error("Session is not active");
		}
		this.inputChannel.push({
			type: "user",
			message: { role: "user", content: message },
			parent_tool_use_id: null,
			session_id: this.queryHandle?.sessionId ?? "",
		});
	}

	async close(): Promise<void> {
		if (!this.active) return;
		this.active = false;

		if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
		if (this.inputChannel) {
			this.inputChannel.close();
		}
		this.abortController.abort();

		// Wait for output processing to finish (with timeout to avoid hanging
		// if the query iterator doesn't respond to abort)
		if (this.processOutputPromise) {
			try {
				await Promise.race([
					this.processOutputPromise,
					new Promise<void>((resolve) => setTimeout(resolve, 1000)),
				]);
			} catch {
				// Expected when aborted
			}
		}

		this.flushTextBlock();

		this.eventBus.emit({
			id: nanoid(),
			timestamp: Date.now(),
			sessionId: this.sessionId,
			agentName: this.agentDef.name,
			type: "session:end",
			payload: { success: true },
		});
	}

	getSessionId(): string {
		return this.sessionId;
	}

	isActive(): boolean {
		return this.active;
	}

	onEvent(handler: (event: AgentEvent) => void): () => void {
		return this.eventBus.onAny((event) => {
			if (event.sessionId === this.sessionId) {
				handler(event);
			}
		});
	}

	private async processOutput(): Promise<void> {
		if (!this.queryHandle) return;
		try {
			for await (const message of this.queryHandle) {
				this.handleMessage(message);
			}
		} catch {
			// Query was aborted or errored - expected during close
		}
		// Flush remaining text when output ends
		this.flushTextBlock();
	}

	// --- Block chunking methods (same pattern as AgentSession) ---

	private flushTextBlock(): void {
		if (this.textBuffer.length === 0) return;
		if (this.blockFlushTimer) {
			clearTimeout(this.blockFlushTimer);
			this.blockFlushTimer = null;
		}
		this.eventBus.emit({
			id: nanoid(),
			timestamp: Date.now(),
			sessionId: this.sessionId,
			agentName: this.agentDef.name,
			type: "agent:message",
			payload: { text: this.textBuffer, chunked: true },
			traceId: this.traceId,
		});
		this.textBuffer = "";
	}

	private appendToBlock(text: string): void {
		this.textBuffer += text;

		if (this.textBuffer.length >= this.BLOCK_MAX_CHARS) {
			const lastBreak = this.textBuffer.lastIndexOf("\n\n");
			if (lastBreak > this.BLOCK_MIN_CHARS) {
				const block = this.textBuffer.slice(0, lastBreak + 2);
				this.textBuffer = this.textBuffer.slice(lastBreak + 2);
				this.eventBus.emit({
					id: nanoid(),
					timestamp: Date.now(),
					sessionId: this.sessionId,
					agentName: this.agentDef.name,
					type: "agent:message",
					payload: { text: block, chunked: true },
					traceId: this.traceId,
				});
			} else {
				this.flushTextBlock();
			}
			return;
		}

		if (this.blockFlushTimer) clearTimeout(this.blockFlushTimer);
		this.blockFlushTimer = setTimeout(() => {
			if (this.textBuffer.length >= this.BLOCK_MIN_CHARS) {
				this.flushTextBlock();
			}
		}, this.BLOCK_FLUSH_DELAY_MS);
	}

	private emitTurnComplete(): void {
		this.flushTextBlock();
		this.inTurn = false;
		this.eventBus.emit({
			id: nanoid(),
			timestamp: Date.now(),
			sessionId: this.sessionId,
			agentName: this.agentDef.name,
			type: "agent:completion",
			payload: {},
			traceId: this.traceId,
		});
	}

	private resetTurnIdleTimer(): void {
		if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
		this.turnIdleTimer = setTimeout(() => {
			if (this.inTurn) {
				this.emitTurnComplete();
			}
		}, this.TURN_IDLE_MS);
	}

	private handleMessage(message: Record<string, any>): void {
		if (message.type === "result") {
			// Explicit turn complete from SDK
			if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
			if (this.inTurn) {
				this.emitTurnComplete();
			}
			return;
		}

		if (message.type === "assistant") {
			this.inTurn = true;
			this.resetTurnIdleTimer();
			const content = message.message?.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						this.appendToBlock(block.text);
					} else if (block.type === "tool_use") {
						this.eventBus.emit({
							id: nanoid(),
							timestamp: Date.now(),
							sessionId: this.sessionId,
							agentName: this.agentDef.name,
							type: "agent:tool_call",
							payload: { toolUse: block },
							traceId: this.traceId,
						});
					}
				}
			} else if (typeof content === "string" && content) {
				this.appendToBlock(content);
			}
		}
	}
}
