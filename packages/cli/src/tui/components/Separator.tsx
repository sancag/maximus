import React from "react";
import { Text, useStdout } from "ink";

export function Separator() {
	const { stdout } = useStdout();
	const width = stdout?.columns ?? 80;
	return <Text dimColor>{"\u2500".repeat(width)}</Text>;
}
