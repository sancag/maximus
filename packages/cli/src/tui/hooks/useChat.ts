import { useState, useCallback, useRef, useEffect } from "react";
import type { Message } from "../components/ChatMessage.js";
import type { StatusState } from "../../repl/status-footer.js";
import {
	connectPersistentStream,
	sendPersistentMessage,
} from "../../commands/chat.js";
import { ensureServerRunning } from "../../repl/ensure-server.js";

export interface UseChatResult {
	messages: Message[];
	streamingText: string;
	streamingAgent: string;
	isStreaming: boolean;
	sendMessage: (text: string) => void;
	cancelStreaming: () => void;
}

export function useChat(
	onStatusChange: (partial: Partial<StatusState>) => void,
): UseChatResult {
	const [messages, setMessages] = useState<Message[]>([]);
	const [streamingText, setStreamingText] = useState("");
	const [streamingAgent, setStreamingAgent] = useState("maximus");
	const [isStreaming, setIsStreaming] = useState(false);
	const idCounter = useRef(0);
	const disconnectRef = useRef<(() => void) | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	const streamingTextRef = useRef("");

	// Keep streamingTextRef in sync with streamingText state
	useEffect(() => {
		streamingTextRef.current = streamingText;
	}, [streamingText]);

	// Establish persistent SSE connection on mount
	useEffect(() => {
		let cancelled = false;

		(async () => {
			const serverOk = await ensureServerRunning(onStatusChange);
			if (!serverOk || cancelled) return;

			const disconnect = connectPersistentStream({
				onConnected: (sessionId) => {
					sessionIdRef.current = sessionId;
				},
				onChunk: (text) => {
					setStreamingText((prev) => prev + text);
				},
				onDone: (sessionId) => {
					sessionIdRef.current = sessionId;
					// Capture current streaming text and push as agent message
					setStreamingText((current) => {
						if (current) {
							const agentId = `msg-${++idCounter.current}`;
							setMessages((prev) => [
								...prev,
								{
									id: agentId,
									role: "agent",
									agentName: "maximus",
									content: current,
								},
							]);
						}
						return "";
					});
					setIsStreaming(false);
				},
				onError: (err) => {
					const errId = `msg-${++idCounter.current}`;
					setMessages((prev) => [
						...prev,
						{
							id: errId,
							role: "agent",
							agentName: "system",
							content: `Error: ${err}`,
						},
					]);
					setStreamingText("");
					setIsStreaming(false);
				},
				onToolCall: (_tool, _input) => {
					// Tool call events can be displayed in future iterations
				},
			});

			disconnectRef.current = disconnect;
		})();

		return () => {
			cancelled = true;
			disconnectRef.current?.();
		};
	}, [onStatusChange]);

	const cancelStreaming = useCallback(() => {
		setStreamingText("");
		setIsStreaming(false);
		// Do NOT disconnect — session stays alive
	}, []);

	const sendMessage = useCallback(
		(text: string) => {
			if (!text.trim()) return;
			const userId = `msg-${++idCounter.current}`;
			const userMsg: Message = {
				id: userId,
				role: "user",
				content: text,
			};

			setMessages((prev) => [...prev, userMsg]);
			setIsStreaming(true);
			setStreamingAgent("maximus");
			setStreamingText("");

			// Fire-and-forget: SSE stream handles the response chunks
			sendPersistentMessage(text).catch((err) => {
				const errId = `msg-${++idCounter.current}`;
				setMessages((prev) => [
					...prev,
					{
						id: errId,
						role: "agent",
						agentName: "system",
						content: `Error: ${err instanceof Error ? err.message : String(err)}`,
					},
				]);
				setStreamingText("");
				setIsStreaming(false);
			});
		},
		[],
	);

	return {
		messages,
		streamingText,
		streamingAgent,
		isStreaming,
		sendMessage,
		cancelStreaming,
	};
}
