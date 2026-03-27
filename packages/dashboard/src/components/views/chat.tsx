"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Send, RotateCcw } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "@/hooks/use-store";
import { EmptyState } from "@/components/shared/empty-state";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function ChatView() {
	const chatMessages = useStore((s) => s.chatMessages);
	const addChatMessage = useStore((s) => s.addChatMessage);
	const updateLastChatMessage = useStore((s) => s.updateLastChatMessage);
	const setLastMessageStreaming = useStore(
		(s) => s.setLastMessageStreaming,
	);
	const clearChatMessages = useStore((s) => s.clearChatMessages);

	const [input, setInput] = useState("");
	const [isStreaming, setIsStreaming] = useState(false);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [chatMessages]);

	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!text || isStreaming) return;

		// Add user message
		addChatMessage({
			id: generateId(),
			role: "user",
			content: text,
			timestamp: Date.now(),
		});

		setInput("");
		setIsStreaming(true);

		// Add placeholder assistant message
		const assistantId = generateId();
		addChatMessage({
			id: assistantId,
			role: "assistant",
			content: "",
			timestamp: Date.now(),
			streaming: true,
		});

		try {
			const response = await api.sendMessage(text);
			if (!response.body) {
				throw new Error("No response body");
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				// Keep last incomplete line in buffer
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const jsonStr = line.slice(6).trim();
					if (!jsonStr) continue;

					try {
						const event = JSON.parse(jsonStr) as {
							type: string;
							content: string;
						};

						if (event.type === "chunk") {
							if (event.content) {
								updateLastChatMessage(
									(prev) => prev + event.content,
								);
							}
						} else if (event.type === "done") {
							if (event.content) {
								updateLastChatMessage(
									() => event.content,
								);
							}
							setLastMessageStreaming(false);
						} else if (event.type === "error") {
							updateLastChatMessage(
								() => `Error: ${event.content}`,
							);
							setLastMessageStreaming(false);
						}
					} catch {
						// Skip malformed JSON lines
					}
				}
			}
		} catch (error) {
			const errMsg =
				error instanceof Error ? error.message : "Unknown error";
			updateLastChatMessage(() => `Error: ${errMsg}`);
			setLastMessageStreaming(false);
		} finally {
			setIsStreaming(false);
		}
	}, [
		input,
		isStreaming,
		addChatMessage,
		updateLastChatMessage,
		setLastMessageStreaming,
	]);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	if (chatMessages.length === 0 && !isStreaming) {
		return (
			<div className="flex h-full flex-col">
				<div className="flex flex-1 items-center justify-center">
					<EmptyState
						icon={MessageCircle}
						heading="Mission Control Ready"
						body="Send a message to your orchestrator agent to begin. Your agent team is standing by."
					/>
				</div>
				<div className="flex items-end gap-3 border-t border-border bg-surface p-4">
					<textarea
						ref={textareaRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Message orchestrator..."
						rows={1}
						className="flex-1 resize-none rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none"
					/>
					<button
						type="button"
						onClick={handleSend}
						disabled={!input.trim()}
						className={cn(
							"flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
							input.trim()
								? "bg-accent text-dominant"
								: "bg-border text-text-secondary",
						)}
					>
						<Send size={18} />
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-1 flex-col gap-3 overflow-y-auto p-6">
				{chatMessages.map((msg) => (
					<div
						key={msg.id}
						className={cn(
							"max-w-[70%] rounded-lg p-4 text-sm",
							msg.role === "user"
								? "ml-auto bg-elevated"
								: "mr-auto bg-surface",
							msg.streaming &&
								"shadow-[var(--glow-accent-strong)]",
						)}
					>
						{msg.role === "assistant" ? (
							<div className="prose prose-invert prose-sm max-w-none prose-headings:text-text-primary prose-p:text-text-primary prose-strong:text-text-primary prose-code:text-accent prose-code:before:content-none prose-code:after:content-none prose-pre:bg-dominant prose-pre:border prose-pre:border-border prose-a:text-accent prose-li:text-text-primary">
								<Markdown
									remarkPlugins={[remarkGfm]}
									components={{
										code: ({
											className,
											children,
											...props
										}) => {
											const isBlock =
												className?.includes(
													"language-",
												);
											if (isBlock) {
												return (
													<pre className="overflow-x-auto rounded bg-dominant border border-border p-3 font-mono text-xs">
														<code
															className={
																className
															}
															{...props}
														>
															{children}
														</code>
													</pre>
												);
											}
											return (
												<code
													className="rounded bg-elevated px-1.5 py-0.5 text-accent text-xs"
													{...props}
												>
													{children}
												</code>
											);
										},
										pre: ({ children }) => <>{children}</>,
										table: ({ children }) => (
											<div className="overflow-x-auto my-3">
												<table className="w-full text-sm border-collapse">{children}</table>
											</div>
										),
										thead: ({ children }) => (
											<thead className="border-b border-border">{children}</thead>
										),
										th: ({ children }) => (
											<th className="px-3 py-2 text-left text-xs font-semibold text-text-secondary">{children}</th>
										),
										td: ({ children }) => (
											<td className="px-3 py-2 border-t border-border text-text-primary">{children}</td>
										),
									}}
								>
									{msg.content}
								</Markdown>
								{msg.streaming && (
									<span className="ml-1 inline-block h-4 w-1 animate-[pulse-dot_1s_ease-in-out_infinite] bg-accent" />
								)}
							</div>
						) : (
							msg.content
						)}
					</div>
				))}
				<div ref={messagesEndRef} />
			</div>

			<div className="flex items-end gap-3 border-t border-border bg-surface p-4">
				<button
					type="button"
					onClick={async () => {
						clearChatMessages();
						await api.sendMessage("").catch(() => {});
						await fetch("/api/chat/new", { method: "POST" }).catch(() => {});
					}}
					disabled={isStreaming || chatMessages.length === 0}
					title="New chat"
					className={cn(
						"flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors",
						chatMessages.length > 0 && !isStreaming
							? "bg-elevated text-text-secondary hover:text-text-primary"
							: "bg-border text-text-secondary/50",
					)}
				>
					<RotateCcw size={16} />
				</button>
				<textarea
					ref={textareaRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder="Message orchestrator..."
					rows={1}
					className="flex-1 resize-none rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none"
				/>
				<button
					type="button"
					onClick={handleSend}
					disabled={!input.trim() || isStreaming}
					className={cn(
						"flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors",
						input.trim() && !isStreaming
							? "bg-accent text-dominant"
							: "bg-border text-text-secondary",
					)}
				>
					<Send size={18} />
				</button>
			</div>
		</div>
	);
}
