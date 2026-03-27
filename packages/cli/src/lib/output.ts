import chalk from "chalk";
import ora from "ora";
import Table from "cli-table3";

// Brand colors
export const gold = chalk.hex("#E8A422");
export const dimGold = chalk.hex("#C4851A");
export const darkGold = chalk.hex("#8B6914");

export function success(msg: string): void {
	console.log(chalk.green("\u2713"), msg);
}

export function info(msg: string): void {
	console.log(chalk.blue("\u2139"), msg);
}

export function warn(msg: string): void {
	console.warn(chalk.yellow("\u26A0"), msg);
}

export function createTable(head: string[]): Table.Table {
	return new Table({
		head: head.map((h) => chalk.bold(h)),
		style: { head: [], border: [] },
	});
}

export function createSpinner(text: string) {
	return ora({ text, isSilent: !!process.env.NO_COLOR });
}

export interface ServerStatus {
	running: boolean;
	agents?: { active?: number; idle?: number };
	tasks?: { running?: number; pending?: number };
	uptime?: string;
}

export function printBanner(version: string, status?: ServerStatus): void {
	console.log();
	console.log(`  ${dimGold("≺((")} ${gold.bold("MAXIMUS")} ${dimGold("))≻")}`);
	console.log(`  ${dimGold("  \\__________/")}`);
	console.log(`  ${dimGold("     ")}${gold("❦")} ${gold("❦")} ${gold("❦")}`);
	console.log();
	console.log(`  ${dimGold("agent orchestration platform")}`);
	console.log(`  ${darkGold(`v${version}`)}  ${darkGold("·")}  ${darkGold("MIT license")}`);

	if (status?.running) {
		console.log();
		const a = status.agents ?? {};
		const t = status.tasks ?? {};
		console.log(`  ${dimGold("agents")}  ${gold(`${a.active ?? 0} active`)}  ${darkGold("·")}  ${dimGold(`${a.idle ?? 0} idle`)}`);
		console.log(`  ${dimGold("tasks")}   ${gold(`${t.running ?? 0} running`)}  ${darkGold("·")}  ${dimGold(`${t.pending ?? 0} pending`)}`);
		console.log(`  ${dimGold("uptime")}  ${dimGold(status.uptime ?? "0s")}`);
	}

	console.log();
	console.log(`  ${dimGold("run")} ${gold("maximus --help")} ${dimGold("to see commands")}`);
	console.log();
}

export function printHeader(): void {
	console.log();
	console.log(`  ${dimGold("≺((")} ${gold.bold("MAXIMUS")} ${dimGold("))≻")}`);
	console.log(`  ${dimGold("  \\__________/")}`);
	console.log(`  ${dimGold("     ")}${gold("❦")} ${gold("❦")} ${gold("❦")}`);
}

export function formatHelpSection(title: string, items: Array<{ name: string; desc: string }>): void {
	console.log();
	console.log(`  ${gold(title)}`);
	console.log();
	for (const item of items) {
		console.log(`  ${chalk.white(item.name.padEnd(28))}${dimGold(item.desc)}`);
	}
}
