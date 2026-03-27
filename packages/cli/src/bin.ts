import { loadProjectEnv } from "./lib/project.js";
import { program } from "./program.js";

loadProjectEnv();

program.parseAsync(process.argv).catch((err: unknown) => {
	// Commander throws on --help and --version with exitOverride enabled
	if (
		err &&
		typeof err === "object" &&
		"code" in err &&
		typeof err.code === "string" &&
		err.code.startsWith("commander.")
	) {
		const isHelp = err.code === "commander.help" || err.code === "commander.helpDisplayed" || err.code === "commander.version";
		process.exit(isHelp ? 0 : ("exitCode" in err && typeof err.exitCode === "number" ? err.exitCode : 0));
	}
	console.error(err);
	process.exit(1);
});
