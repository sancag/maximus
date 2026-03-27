import React, { useMemo, useCallback, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { Separator } from "./components/Separator.js";
import { StatusBar } from "./components/StatusBar.js";
import { Header } from "./components/Header.js";
import { ChatMessage } from "./components/ChatMessage.js";
import type { Message } from "./components/ChatMessage.js";
import { StreamingMessage } from "./components/StreamingMessage.js";
import { InputArea } from "./components/InputArea.js";
import { useChat } from "./hooks/useChat.js";
import { useServerStatus } from "./hooks/useServerStatus.js";
import {
	createSlashDispatcher,
	registerDefaultCommands,
} from "../repl/slash-commands.js";

type StaticItem = { id: string; type: "header" } | (Message & { type: "message" });

export function App() {
	const { exit } = useApp();
	const { status, updateStatus } = useServerStatus();
	const { messages, streamingText, streamingAgent, isStreaming, sendMessage, cancelStreaming } =
		useChat(updateStatus);
	const [hint, setHint] = useState("");
	const [inputValue, setInputValue] = useState("");
	const [inquirerMode, setInquirerMode] = useState(false);

	const dispatcher = useMemo(() => {
		const d = createSlashDispatcher();
		registerDefaultCommands(d, {
			onExit: () => exit(),
			onInit: async () => {
				setInquirerMode(true);
				try {
					const { runInitWizard } = await import("../commands/init.js");
					await runInitWizard();
					updateStatus({ projectInitialized: true });
				} finally {
					setInquirerMode(false);
				}
			},
			onServerStateChange: (online) => updateStatus({ serverOnline: online }),
			pauseInput: () => setInquirerMode(true),
			resumeInput: () => setInquirerMode(false),
		});
		return d;
	}, [exit, updateStatus]);

	const handleSubmit = useCallback(
		async (text: string) => {
			if (text.startsWith("/")) {
				const handled = await dispatcher.dispatch(text);
				if (handled) return;
			}
			sendMessage(text);
		},
		[dispatcher, sendMessage],
	);

	// Ctrl-C handling
	useInput((_input, key) => {
		if (key.ctrl && _input === "c") {
			if (isStreaming) {
				// Cancel visual stream — SSE may still complete in background
				cancelStreaming();
			} else if (inputValue !== "") {
				// Clear current input text
				setInputValue("");
			} else {
				// Empty input, not streaming — show hint
				setHint("Type /exit to quit");
				setTimeout(() => setHint(""), 3000);
			}
		}
	});

	// Build static items: header + completed messages
	const staticItems: StaticItem[] = useMemo(() => {
		const items: StaticItem[] = [{ id: "header", type: "header" }];
		for (const msg of messages) {
			items.push({ ...msg, type: "message" });
		}
		return items;
	}, [messages]);

	// In inquirer mode, render nothing in the dynamic area so inquirer can take stdin
	if (inquirerMode) {
		return <Box flexDirection="column" />;
	}

	return (
		<Box flexDirection="column">
			{/* Completed messages scroll away */}
			<Static items={staticItems}>
				{(item) => {
					if (item.type === "header") {
						return <Header key="header" />;
					}
					return <ChatMessage key={item.id} message={item} />;
				}}
			</Static>

			{/* Streaming response */}
			{isStreaming && (
				<StreamingMessage agentName={streamingAgent} content={streamingText} />
			)}

			{/* Dynamic area: input + status (always visible) */}
			<Separator />
			<InputArea
				onSubmit={handleSubmit}
				value={inputValue}
				onChange={setInputValue}
			/>
			<Separator />
			<StatusBar state={status} />

			{/* Hint messages */}
			{hint !== "" && (
				<Text dimColor>{hint}</Text>
			)}
		</Box>
	);
}
