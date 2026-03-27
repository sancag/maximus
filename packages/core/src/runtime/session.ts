import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition } from "@maximus/shared";
import type { SessionConfig, SessionResult } from "./types.js";
import { EventBus } from "../events/bus.js";
import { createHooks, filterEnvForSdk } from "./hooks.js";
import { nanoid } from "nanoid";
import pino from "pino";

const logger = pino({ name: "agent-session" });

export class AgentSession {
	private sessionId: string;
	private abortController: AbortController;
	private traceId: string;
	private parentSessionId?: string;

	// Block chunking state
	private textBuffer: string = "";
	private readonly BLOCK_MIN_CHARS = 80;
	private readonly BLOCK_MAX_CHARS = 2000;
	private blockFlushTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly BLOCK_FLUSH_DELAY_MS = 150;

	constructor(
		private agentDef: AgentDefinition,
		private mcpServers: Record<string, any>,
		private eventBus: EventBus,
		private config: SessionConfig,
	) {
		this.sessionId = config.sessionId ?? nanoid();
		this.traceId = config.traceId ?? nanoid();
		this.parentSessionId = config.parentSessionId;
		this.abortController = new AbortController();
		if (config.abortSignal) {
			config.abortSignal.addEventListener("abort", () =>
				this.abortController.abort(),
			);
		}
	}

	async run(): Promise<SessionResult> {
		const startTime = Date.now();
		const maxDuration =
			this.config.maxDurationSeconds ??
			this.agentDef.maxDurationSeconds;
		let durationTimer: ReturnType<typeof setTimeout> | undefined;
		if (maxDuration) {
			durationTimer = setTimeout(() => {
				logger.warn(
					{
						agent: this.agentDef.name,
						sessionId: this.sessionId,
						maxDurationSeconds: maxDuration,
					},
					"Session exceeded max duration, aborting",
				);
				this.abortController.abort();
			}, maxDuration * 1000);
		}

		const hooks = createHooks(
			this.eventBus,
			this.agentDef.name,
			this.sessionId,
			this.traceId,
			this.config.maxToolResultChars ?? 2000,
		);

		this.eventBus.emit({
			id: nanoid(),
			timestamp: Date.now(),
			sessionId: this.sessionId,
			agentName: this.agentDef.name,
			type: "session:start",
			payload: { prompt: this.config.prompt },
			traceId: this.traceId,
			parentSessionId: this.parentSessionId,
		});

		try {
			let output = "";
			let lastAssistantText = "";
			let numTurns = 0;
			let totalCostUsd = 0;
			let resultSubtype = "";

			for await (const message of query({
				prompt: this.config.prompt,
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
				...(this.config.sessionId
					? { resume: this.config.sessionId }
					: {}),
			})) {
				this.handleMessage(message);

				// Track last assistant text for fallback output
				if (message.type === "assistant") {
					const content = message.message?.content;
					if (Array.isArray(content)) {
						for (const block of content) {
							if (block.type === "text" && block.text) {
								lastAssistantText = block.text;
							}
						}
					} else if (typeof content === "string" && content) {
						lastAssistantText = content;
					}
				}

				if (message.type === "result") {
					resultSubtype = message.subtype ?? "";
					numTurns = message.num_turns ?? 0;
					totalCostUsd = message.total_cost_usd ?? 0;

					if (message.subtype === "success") {
						output =
							typeof message.result === "string"
								? message.result
								: JSON.stringify(message.result);
					} else {
						// Non-success result (e.g. error_max_turns) —
						// capture last assistant output so it's not silently lost
						output = lastAssistantText;
						logger.warn(
							{
								agent: this.agentDef.name,
								sessionId: this.sessionId,
								traceId: this.traceId,
								subtype: message.subtype,
								numTurns,
							},
							"Agent session ended with non-success result",
						);
					}
				}
			}

			// Flush any remaining buffered text
			this.flushTextBlock();
			if (durationTimer) clearTimeout(durationTimer);

			const success = resultSubtype === "success";

			this.eventBus.emit({
				id: nanoid(),
				timestamp: Date.now(),
				sessionId: this.sessionId,
				agentName: this.agentDef.name,
				type: "session:end",
				payload: { success, resultSubtype, numTurns, totalCostUsd },
				traceId: this.traceId,
				parentSessionId: this.parentSessionId,
			});

			return {
				sessionId: this.sessionId,
				success,
				output,
				numTurns,
				totalCostUsd,
				durationMs: Date.now() - startTime,
				traceId: this.traceId,
			};
		} catch (error) {
			const errorMsg =
				error instanceof Error ? error.message : String(error);

			// Flush any remaining buffered text before error
			this.flushTextBlock();
			if (durationTimer) clearTimeout(durationTimer);

			this.eventBus.emit({
				id: nanoid(),
				timestamp: Date.now(),
				sessionId: this.sessionId,
				agentName: this.agentDef.name,
				type: "agent:error",
				payload: { error: errorMsg },
				traceId: this.traceId,
				parentSessionId: this.parentSessionId,
			});

			return {
				sessionId: this.sessionId,
				success: false,
				error: errorMsg,
				durationMs: Date.now() - startTime,
				traceId: this.traceId,
			};
		}
	}

	abort(): void {
		this.abortController.abort();
	}

	getSessionId(): string {
		return this.sessionId;
	}

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
			payload: { text: this.textBuffer, content: this.textBuffer, chunked: true },
			traceId: this.traceId,
			parentSessionId: this.parentSessionId,
		});
		this.textBuffer = "";
	}

	private appendToBlock(text: string): void {
		this.textBuffer += text;

		// Force flush if over max size
		if (this.textBuffer.length >= this.BLOCK_MAX_CHARS) {
			// Try to break at last paragraph boundary (double newline)
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
					payload: { text: block, content: block, chunked: true },
					traceId: this.traceId,
					parentSessionId: this.parentSessionId,
				});
			} else {
				this.flushTextBlock();
			}
			return;
		}

		// Reset the idle flush timer
		if (this.blockFlushTimer) clearTimeout(this.blockFlushTimer);
		this.blockFlushTimer = setTimeout(() => {
			if (this.textBuffer.length >= this.BLOCK_MIN_CHARS) {
				this.flushTextBlock();
			}
		}, this.BLOCK_FLUSH_DELAY_MS);
	}

	private handleMessage(message: Record<string, any>): void {
		// Emit events for each message type for observability
		if (message.type === "assistant") {
			// Buffer text content into coherent blocks instead of emitting raw deltas
			const content = message.message?.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						this.appendToBlock(block.text);
					} else if (block.type === "tool_use") {
						// Flush any buffered text so it streams before the tool blocks
						this.flushTextBlock();
						this.eventBus.emit({
							id: nanoid(),
							timestamp: Date.now(),
							sessionId: this.sessionId,
							agentName: this.agentDef.name,
							type: "agent:tool_call",
							payload: {
								toolUse: block,  // Keep for backward compat
								tool: block.name,     // Flattened alias
								input: block.input,   // Flattened alias
							},
							traceId: this.traceId,
							parentSessionId: this.parentSessionId,
						});
					}
				}
			} else if (typeof content === "string" && content) {
				this.appendToBlock(content);
			}
		}
	}
}
