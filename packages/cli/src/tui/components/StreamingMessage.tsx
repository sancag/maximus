import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";

function BlinkingCursor() {
	const [visible, setVisible] = useState(true);

	useEffect(() => {
		const timer = setInterval(() => {
			setVisible((v) => !v);
		}, 500);
		return () => clearInterval(timer);
	}, []);

	return visible ? <Text inverse> </Text> : <Text> </Text>;
}

export interface StreamingMessageProps {
	agentName: string;
	content: string;
}

export function StreamingMessage({ agentName, content }: StreamingMessageProps) {
	return (
		<Box flexDirection="column">
			<Text color="#E8A422" bold>
				{agentName}:
			</Text>
			<Text>
				{content}
				<BlinkingCursor />
			</Text>
		</Box>
	);
}
