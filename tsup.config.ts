import { defineConfig } from "tsup"

// One image, three entrypoints: the API process, the worker process, and the
// migration runner that the deploy step executes before either starts.
export default defineConfig({
	entry: ["src/main.api.ts", "src/main.worker.ts", "src/db/migrate.ts"],
	format: "esm",
	outDir: "dist",
	target: "node22",
	clean: true,
	dts: false,
	sourcemap: true,
})
