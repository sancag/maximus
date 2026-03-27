import React from "react";
import { Text, Box } from "ink";
import TextInput from "ink-text-input";

export interface InputAreaProps {
	onSubmit: (text: string) => void;
	value: string;
	onChange: (text: string) => void;
}

export function InputArea({ onSubmit, value, onChange }: InputAreaProps) {
	function handleSubmit(text: string) {
		const trimmed = text.trim();
		if (!trimmed) return;
		onSubmit(trimmed);
		onChange("");
	}

	return (
		<Box>
			<Text color="#E8A422">&gt; </Text>
			<TextInput value={value} onChange={onChange} onSubmit={handleSubmit} focus={true} />
		</Box>
	);
}
