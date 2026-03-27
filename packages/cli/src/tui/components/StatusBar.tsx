import React from "react";
import { Text, Box } from "ink";
import type { StatusState } from "../../repl/status-footer.js";

export interface StatusBarProps {
	state: StatusState;
}

export function StatusBar({ state }: StatusBarProps) {
	return (
		<Box justifyContent="space-between" width="100%">
			<Box>
				<StatusLeft state={state} />
			</Box>
			<Box>
				<Text color="#C4851A" dimColor>/help for commands</Text>
			</Box>
		</Box>
	);
}

function StatusLeft({ state }: { state: StatusState }) {
	if (!state.projectInitialized) {
		return (
			<Text>
				<Text color="red">{"\u25CB"}</Text>{" "}
				<Text color="#C4851A">no agents</Text>
				{"  "}
				<Text color="#8B6914">{"\u00B7"}</Text>
				{"  "}
				<Text color="#C4851A">type /init to get started</Text>
			</Text>
		);
	}

	if (!state.serverOnline) {
		return (
			<Text>
				<Text color="red">{"\u25CB"}</Text>{" "}
				<Text color="#C4851A">server offline</Text>
				{"  "}
				<Text color="#8B6914">{"\u00B7"}</Text>
				{"  "}
				<Text color="#C4851A">type /start to launch</Text>
			</Text>
		);
	}

	const parts: React.ReactNode[] = [
		<Text key="online">
			<Text color="green">{"\u25CF"}</Text>{" "}
			<Text color="#C4851A">server online</Text>
		</Text>,
	];

	if (state.activeAgent) {
		parts.push(
			<Text key="agent" color="#E8A422">
				{"  "}
				<Text color="#8B6914">{"\u00B7"}</Text>
				{"  "}
				{state.activeAgent}
			</Text>,
		);
	}

	parts.push(
		<Text key="agents">
			{"  "}
			<Text color="#8B6914">{"\u00B7"}</Text>
			{"  "}
			<Text color="#E8A422">{state.agentCount}</Text>{" "}
			<Text color="#C4851A">agents</Text>
		</Text>,
	);

	if (state.taskCount > 0) {
		parts.push(
			<Text key="tasks">
				{"  "}
				<Text color="#8B6914">{"\u00B7"}</Text>
				{"  "}
				<Text color="#E8A422">{state.taskCount}</Text>{" "}
				<Text color="#C4851A">tasks</Text>
			</Text>,
		);
	}

	parts.push(
		<Text key="uptime">
			{"  "}
			<Text color="#8B6914">{"\u00B7"}</Text>
			{"  "}
			<Text color="#C4851A">{state.uptime}</Text>
		</Text>,
	);

	return <Text>{parts}</Text>;
}
