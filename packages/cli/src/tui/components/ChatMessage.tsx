import React from "react";
import { Text, Box } from "ink";
import { MarkdownText } from "./MarkdownText.js";

export interface Message {
	id: string;
	role: "user" | "agent";
	agentName?: string;
	content: string;
}

export interface ChatMessageProps {
	message: Message;
}

export function ChatMessage({ message }: ChatMessageProps) {
	if (message.role === "user") {
		return (
			<Box flexDirection="column" marginBottom={1}>
				<Text dimColor>&gt; {message.content}</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text color="#E8A422" bold>
				{message.agentName ?? "maximus"}:
			</Text>
			<MarkdownText content={message.content} />
		</Box>
	);
}
