import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: true,
	target: "node20",
	platform: "node",
	external: ["kuzu", "better-sqlite3"],
	clean: true,
});
