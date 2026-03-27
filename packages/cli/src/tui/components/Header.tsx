import React from "react";
import { Text, Box } from "ink";

const VERSION = "0.1.0";

// Hex-M logo: hexagon outline (dim gold) with M circuit trace (bright gold) and node dots
// Mirrors the SVG favicon: packages/dashboard/src/app/favicon.svg
const bright = "#E8A422";
const dim = "#C4851A";
const dark = "#8B6914";

function c(cols: number, textWidth: number): string {
	return " ".repeat(Math.max(0, Math.floor((cols - textWidth) / 2)));
}

export function Header() {
	const cols = process.stdout.columns ?? 80;
	// Logo widest row is 17 chars: "█    █ ▀█▀ █    █"
	const w = 17;
	const p = c(cols, w);

	return (
		<Box flexDirection="column">
			<Text>{p}{"       "}<Text color={dim}>{"▄█▄"}</Text></Text>
			<Text>{p}{"     "}<Text color={dim}>{"▄▀"}</Text>{"   "}<Text color={dim}>{"▀▄"}</Text></Text>
			<Text>{p}{"   "}<Text color={dim}>{"▄▀"}</Text>{"       "}<Text color={dim}>{"▀▄"}</Text></Text>
			<Text>{p}{" "}<Text color={dim}>{"▄▀"}</Text>{"   "}<Text color={bright}>{"█▄ ▄█"}</Text>{"   "}<Text color={dim}>{"▀▄"}</Text></Text>
			<Text>{p}<Text color={dim}>{"█"}</Text>{"    "}<Text color={bright}>{"█ ▀█▀ █"}</Text>{"    "}<Text color={dim}>{"█"}</Text></Text>
			<Text>{p}<Text color={dim}>{"█"}</Text>{"    "}<Text color={bright}>{"█  █  █"}</Text>{"    "}<Text color={dim}>{"█"}</Text></Text>
			<Text>{p}<Text color={dim}>{"█"}</Text>{"    "}<Text color={bright}>{"█     █"}</Text>{"    "}<Text color={dim}>{"█"}</Text></Text>
			<Text>{p}{" "}<Text color={dim}>{"▀▄"}</Text>{"   "}<Text color={bright}>{"█   █"}</Text>{"   "}<Text color={dim}>{"▄▀"}</Text></Text>
			<Text>{p}{"   "}<Text color={dim}>{"▀▄"}</Text>{"       "}<Text color={dim}>{"▄▀"}</Text></Text>
			<Text>{p}{"     "}<Text color={dim}>{"▀▄"}</Text>{"   "}<Text color={dim}>{"▄▀"}</Text></Text>
			<Text>{p}{"       "}<Text color={dim}>{"▀█▀"}</Text></Text>
			<Text> </Text>
			<Text>{c(cols, 7)}<Text color={bright} bold>MAXIMUS</Text></Text>
			<Text>{c(cols, 30)}<Text color={dim}>agent orchestration platform</Text></Text>
			<Text>{c(cols, 6)}<Text color={dark}>v{VERSION}</Text></Text>
			<Text> </Text>
		</Box>
	);
}
