import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/server.ts"],
	format: "esm",
	dts: true,
	clean: true,
	deps: { neverBundle: ["cloudflare:workers", "@cloudflare/workers-types"] },
});
