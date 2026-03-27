import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/bin.ts"],
	format: ["esm"],
	target: "node20",
	platform: "node",
	banner: {
		js: [
			"#!/usr/bin/env node",
			'import { createRequire as __gsd_createRequire } from "node:module";',
			"const require = __gsd_createRequire(import.meta.url);",
		].join("\n"),
	},
	noExternal: [/.*/],
	clean: true,
	esbuildOptions(options) {
		options.jsx = "automatic";
		options.jsxImportSource = "react";
		options.external = [...(options.external ?? []), "react-devtools-core", "kuzu", "better-sqlite3"];
	},
});
