import chalk from "chalk";
import { streamChat } from "../commands/chat.js";

export interface StreamRendererOptions {
	onComplete?: () => void;
}

/**
 * Wraps streamChat with inline rendering.
 * Text streams progressively. Delegation visibility comes from
 * WS events updating the status footer separately.
 */
export async function renderStream(
	message: string,
	options?: StreamRendererOptions,
): Promise<void> {
	return new Promise<void>((resolve) => {
		streamChat(
			message,
			(chunk) => {
				process.stdout.write(chunk);
			},
			(_fullText) => {
				process.stdout.write("\n\n");
				options?.onComplete?.();
				resolve();
			},
			(err) => {
				console.error(chalk.red("Error:"), err);
				resolve();
			},
		).catch((err) => {
			// ECONNREFUSED etc.
			console.error(
				chalk.red("Error:"),
				err instanceof Error ? err.message : String(err),
			);
			resolve();
		});
	});
}
