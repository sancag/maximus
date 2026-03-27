import React from "react";
import { Text } from "ink";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

marked.use(markedTerminal());

export interface MarkdownTextProps {
	content: string;
}

export function MarkdownText({ content }: MarkdownTextProps) {
	const rendered = (marked.parse(content) as string).replace(/\n+$/, "");
	return <Text>{rendered}</Text>;
}
