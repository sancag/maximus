import chalk from "chalk";
import stripAnsi from "strip-ansi";

const gold = chalk.hex("#E8A422");
const dimGold = chalk.hex("#C4851A");
const darkGold = chalk.hex("#8B6914");

export interface StatusState {
	serverOnline: boolean;
	agentCount: number;
	taskCount: number;
	uptime: string;
	activeAgent?: string; // e.g. "researcher (searching...)"
	projectInitialized: boolean;
}

export function formatStatusLine(state: StatusState): string {
	if (!state.projectInitialized) {
		return `${chalk.red("\u25CB")} ${dimGold("no agents")}  ${darkGold("\u00B7")}  ${dimGold("type /init to get started")}`;
	}

	if (!state.serverOnline) {
		return `${chalk.red("\u25CB")} ${dimGold("server offline")}  ${darkGold("\u00B7")}  ${dimGold("type /start to launch")}`;
	}

	const parts: string[] = [
		`${chalk.green("\u25CF")} ${dimGold("server online")}`,
	];

	if (state.activeAgent) {
		parts.push(gold(state.activeAgent));
	}

	parts.push(`${gold(String(state.agentCount))} ${dimGold("agents")}`);

	if (state.taskCount > 0) {
		parts.push(`${gold(String(state.taskCount))} ${dimGold("tasks")}`);
	}

	parts.push(dimGold(state.uptime));

	return parts.join(`  ${darkGold("\u00B7")}  `);
}

export class StatusFooter {
	private currentText = "";
	private enabled: boolean;

	constructor() {
		// Only enable ANSI rendering in TTY mode
		this.enabled = !!process.stdout.isTTY;
	}

	/**
	 * Set up the scroll region so readline output stays above the footer.
	 * Reserve the last line of the terminal for the status.
	 */
	setup(): void {
		if (!this.enabled) return;
		const rows = process.stdout.rows ?? 24;
		// Set scroll region to all rows except the last
		process.stdout.write(`\x1b[1;${rows - 1}r`);
		// Move cursor to top-left of scroll region
		process.stdout.write("\x1b[1;1H");

		process.stdout.on("resize", () => this.onResize());
	}

	private onResize(): void {
		if (!this.enabled) return;
		const rows = process.stdout.rows ?? 24;
		process.stdout.write(`\x1b[1;${rows - 1}r`);
		this.render(this.currentText);
	}

	/**
	 * Update the status line content. Debounce externally if needed.
	 */
	update(state: StatusState): void {
		const text = formatStatusLine(state);
		this.render(text);
	}

	private render(text: string): void {
		if (!this.enabled) return;
		this.currentText = text;
		const rows = process.stdout.rows ?? 24;
		const cols = process.stdout.columns ?? 80;

		// Truncate to terminal width
		const plain = stripAnsi(text);
		const truncated =
			plain.length > cols ? text.slice(0, cols - 1) + "..." : text;

		// Save cursor, move to last row, clear line, write, restore cursor
		process.stdout.write("\x1b7"); // Save cursor (DEC)
		process.stdout.write(`\x1b[${rows};1H`); // Move to last row
		process.stdout.write("\x1b[2K"); // Clear entire line
		process.stdout.write(truncated);
		process.stdout.write("\x1b8"); // Restore cursor (DEC)
	}

	/**
	 * Clean up: reset scroll region, clear footer line.
	 */
	destroy(): void {
		if (!this.enabled) return;
		const rows = process.stdout.rows ?? 24;
		// Reset scroll region to full terminal
		process.stdout.write(`\x1b[1;${rows}r`);
		// Clear the last line
		process.stdout.write(`\x1b[${rows};1H`);
		process.stdout.write("\x1b[2K");
		// Move cursor back to normal position
		process.stdout.write("\x1b[1;1H");
		process.stdout.removeAllListeners("resize");
	}
}
