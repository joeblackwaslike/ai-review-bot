import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "api/**/*.test.ts"],
		exclude: [
			"**/node_modules/**",
			"src/replay/seeds/**/base/**",
			"src/replay/seeds/**/head/**",
		],
	},
});
