import chalk from "chalk";

export function errorMessage(msg: string, fix?: string): void {
	console.error(chalk.red("Error:"), msg);
	if (fix) {
		console.error();
		console.error(chalk.dim("  Run:"), chalk.cyan(fix));
	}
}

export function handleCommandError(error: unknown): never {
	if (error instanceof Error) {
		const msg = error.message;
		// Pattern-match common failures to actionable suggestions
		if (msg.includes("Config not found") || msg.includes("No .maximus/ found")) {
			errorMessage("No Maximus project found.", "maximus init");
		} else if (
			msg.includes("ECONNREFUSED") ||
			msg.includes("Server not running")
		) {
			errorMessage("Server not running.", "maximus server start");
		} else if (msg.includes("Credential not found")) {
			errorMessage(msg, "maximus vault list");
		} else {
			errorMessage(msg);
		}
	} else {
		errorMessage(String(error));
	}
	process.exit(1);
}
