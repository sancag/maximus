import { Command } from "commander";
import { request } from "node:http";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { getConfig } from "../lib/config.js";
import { handleCommandError } from "../lib/errors.js";

export function streamChat(
	message: string,
	onChunk: (text: string) => void,
	onDone: (fullText: string) => void,
	onError: (err: string) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const config = getConfig();
		const body = JSON.stringify({ message });

		const req = request(
			{
				hostname: "127.0.0.1",
				port: config.port,
				path: "/api/chat",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				let buffer = "";

				res.on("data", (chunk: Buffer) => {
					buffer += chunk.toString();
					const lines = buffer.split("\n");
					// Keep the last element as remainder (may be incomplete)
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed.startsWith("data: ")) continue;
						try {
							const payload = JSON.parse(trimmed.slice(6));
							if (payload.type === "chunk") {
								onChunk(payload.content);
							} else if (payload.type === "done") {
								onDone(payload.content);
								resolve();
							} else if (payload.type === "error") {
								onError(payload.content);
								resolve();
							}
						} catch {
							// Ignore malformed JSON lines
						}
					}
				});

				res.on("end", () => {
					// Safety net: process any remaining buffered data
					if (buffer.trim().startsWith("data: ")) {
						try {
							const payload = JSON.parse(buffer.trim().slice(6));
							if (payload.type === "chunk") {
								onChunk(payload.content);
							} else if (payload.type === "done") {
								onDone(payload.content);
							} else if (payload.type === "error") {
								onError(payload.content);
							}
						} catch {
							// Ignore
						}
					}
					resolve();
				});
			},
		);

		req.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
				reject(
					new Error(
						"Server not running. Run `maximus server start` first.",
					),
				);
			} else {
				reject(err);
			}
		});

		req.write(body);
		req.end();
	});
}

export interface PersistentStreamCallbacks {
	onConnected?: (sessionId: string) => void;
	onChunk: (text: string) => void;
	onDone: (sessionId: string) => void;
	onError: (err: string) => void;
	onToolCall?: (tool: string, input: unknown) => void;
}

export function connectPersistentStream(
	callbacks: PersistentStreamCallbacks,
): () => void {
	const config = getConfig();
	const req = request(
		{
			hostname: "127.0.0.1",
			port: config.port,
			path: "/api/chat/stream",
			method: "GET",
			headers: { Accept: "text/event-stream" },
		},
		(res) => {
			let buffer = "";
			res.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("data: ")) continue;
					try {
						const payload = JSON.parse(trimmed.slice(6));
						if (payload.type === "connected") {
							callbacks.onConnected?.(payload.sessionId);
						} else if (payload.type === "chunk") {
							callbacks.onChunk(payload.content);
						} else if (payload.type === "done") {
							callbacks.onDone(payload.sessionId);
						} else if (payload.type === "error") {
							callbacks.onError(payload.content);
						} else if (payload.type === "tool_call") {
							callbacks.onToolCall?.(payload.tool, payload.input);
						}
					} catch {
						/* ignore malformed */
					}
				}
			});
		},
	);

	req.on("error", (err) => {
		if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
			callbacks.onError(
				"Server not running. Run `maximus server start` first.",
			);
		} else {
			callbacks.onError(err.message);
		}
	});

	req.end();

	// Return disconnect function
	return () => {
		req.destroy();
	};
}

export function sendPersistentMessage(
	message: string,
): Promise<{ status: string; sessionId: string }> {
	return new Promise((resolve, reject) => {
		const config = getConfig();
		const body = JSON.stringify({ message });
		const req = request(
			{
				hostname: "127.0.0.1",
				port: config.port,
				path: "/api/chat/message",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				let data = "";
				res.on("data", (chunk: Buffer) => {
					data += chunk.toString();
				});
				res.on("end", () => {
					try {
						resolve(JSON.parse(data));
					} catch {
						reject(new Error("Invalid response from server"));
					}
				});
			},
		);
		req.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
				reject(
					new Error(
						"Server not running. Run `maximus server start` first.",
					),
				);
			} else {
				reject(err);
			}
		});
		req.write(body);
		req.end();
	});
}

export function registerChatCommand(parent: Command): void {
	parent
		.command("chat [message]")
		.description("Chat with the orchestrator agent")
		.addHelpText(
			"after",
			"\nExamples:\n  $ maximus chat \"What agents do I have?\"\n  $ maximus chat   # opens interactive REPL",
		)
		.action(async (message?: string) => {
			try {
				if (message) {
					// One-shot mode
					await streamChat(
						message,
						(chunk) => process.stdout.write(chunk),
						() => {
							process.stdout.write("\n");
						},
						(err) => {
							console.error(chalk.red("Error:"), err);
							process.exit(1);
						},
					);
				} else {
					// REPL mode
					const rl = createInterface({
						input: process.stdin,
						output: process.stdout,
						prompt: chalk.cyan("maximus> "),
					});

					console.log(
						chalk.dim(
							"Interactive chat with orchestrator. Type /exit to quit.\n",
						),
					);
					rl.prompt();

					rl.on("line", async (line) => {
						const input = line.trim();

						if (input === "/exit" || input === "/quit") {
							rl.close();
							return;
						}

						if (input === "") {
							rl.prompt();
							return;
						}

						try {
							await streamChat(
								input,
								(chunk) => process.stdout.write(chunk),
								() => {
									process.stdout.write("\n\n");
									rl.prompt();
								},
								(err) => {
									console.error(chalk.red("Error:"), err);
									rl.prompt();
								},
							);
						} catch (err) {
							handleCommandError(err);
						}
					});

					rl.on("close", () => {
						process.exit(0);
					});
				}
			} catch (err) {
				handleCommandError(err);
			}
		});
}
