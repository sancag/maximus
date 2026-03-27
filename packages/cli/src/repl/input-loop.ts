import { createInterface, type Interface } from "node:readline";
import chalk from "chalk";
import type { SlashDispatcher } from "./slash-commands.js";

const gold = chalk.hex("#E8A422");

export interface InputLoopOptions {
	onChat: (message: string) => Promise<void>;
	dispatcher: SlashDispatcher;
	onClose?: () => void;
}

export function startInputLoop(options: InputLoopOptions): {
	rl: Interface;
	pause: () => void;
	resume: () => void;
} {
	const { onChat, dispatcher, onClose } = options;

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: gold("maximus> "),
	});

	let processing = false;

	rl.on("line", async (line) => {
		if (processing) return;
		const input = line.trim();
		if (!input) {
			rl.prompt();
			return;
		}

		processing = true;
		try {
			if (input.startsWith("/")) {
				await dispatcher.dispatch(input);
			} else {
				await onChat(input);
			}
		} catch (err) {
			console.error(
				chalk.red("Error:"),
				err instanceof Error ? err.message : String(err),
			);
		}
		processing = false;
		rl.prompt();
	});

	rl.on("close", () => {
		onClose?.();
	});

	// Handle Ctrl-C gracefully -- just print new line and re-prompt
	rl.on("SIGINT", () => {
		console.log();
		rl.prompt();
	});

	return {
		rl,
		pause: () => rl.pause(),
		resume: () => {
			rl.resume();
			rl.prompt();
		},
	};
}
