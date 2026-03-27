import { Command } from "commander";
import { password, input, confirm } from "@inquirer/prompts";
import { loadVaultFromConfig } from "../lib/vault-helpers.js";
import { success, createTable, warn } from "../lib/output.js";
import { errorMessage, handleCommandError } from "../lib/errors.js";

export function registerVaultCommand(parent: Command): void {
	const vault = parent
		.command("vault")
		.description("Manage encrypted credentials")
		.addHelpText("after", "\nExample:\n  $ maximus vault set OPENAI_KEY");

	vault
		.command("set <name>")
		.description("Store a credential (value prompted securely)")
		.addHelpText("after", "\nExample:\n  $ maximus vault set GITHUB_TOKEN")
		.action(async (name: string) => {
			try {
				const value = await password({ message: "Value:" });
				if (!value) {
					errorMessage("Value cannot be empty.");
					process.exit(1);
				}
				const desc = await input({
					message: "Description (optional):",
					default: "",
				});
				const { vault: v, vaultPath } = await loadVaultFromConfig();
				v.set(name, value, desc ? { description: desc } : undefined);
				v.save(vaultPath);
				success(`Credential "${name}" saved.`);
			} catch (err) {
				handleCommandError(err);
			}
		});

	vault
		.command("get <name>")
		.description("Decrypt and display a credential value")
		.addHelpText(
			"after",
			"\nExample:\n  $ maximus vault get GITHUB_TOKEN | pbcopy",
		)
		.action(async (name: string) => {
			try {
				const { vault: v } = await loadVaultFromConfig();
				const value = v.get(name);
				// Raw output, no chalk, no newline -- pipe-friendly
				process.stdout.write(value);
			} catch (err) {
				handleCommandError(err);
			}
		});

	vault
		.command("list")
		.description("List all stored credentials")
		.addHelpText("after", "\nExample:\n  $ maximus vault list")
		.option("--json", "Output as JSON")
		.action(async (opts) => {
			try {
				const { vault: v } = await loadVaultFromConfig();
				const creds = v.list();

				if (creds.length === 0) {
					warn("No credentials stored.");
					return;
				}

				if (opts.json) {
					console.log(JSON.stringify(creds, null, 2));
					return;
				}

				const table = createTable([
					"Name",
					"Description",
					"Created",
					"Updated",
				]);
				for (const c of creds) {
					table.push([
						c.name,
						c.description ?? "",
						new Date(c.createdAt).toLocaleDateString(),
						new Date(c.updatedAt).toLocaleDateString(),
					]);
				}
				console.log(table.toString());
			} catch (err) {
				handleCommandError(err);
			}
		});

	vault
		.command("delete <name>")
		.description("Remove a credential from the vault")
		.addHelpText(
			"after",
			"\nExample:\n  $ maximus vault delete GITHUB_TOKEN",
		)
		.action(async (name: string) => {
			try {
				const { vault: v, vaultPath } = await loadVaultFromConfig();

				if (!v.has(name)) {
					errorMessage(
						`Credential "${name}" not found.`,
						"maximus vault list",
					);
					process.exit(1);
				}

				const yes = await confirm({
					message: `Delete credential "${name}"?`,
					default: false,
				});

				if (!yes) {
					warn("Delete cancelled.");
					return;
				}

				v.delete(name);
				v.save(vaultPath);
				success(`Credential "${name}" deleted.`);
			} catch (err) {
				handleCommandError(err);
			}
		});
}
