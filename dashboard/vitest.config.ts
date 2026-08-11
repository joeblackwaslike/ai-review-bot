import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// vitest runs "server-only"-marked modules directly under Node, not
		// through Next's RSC bundler, so the package's own "react-server"
		// export condition never activates and its default export throws
		// unconditionally ("cannot be imported from a Client Component").
		// Every module under test here only ever runs server-side, so
		// declaring the react-server condition is correct, not a workaround.
		conditions: ["react-server"],
	},
	test: {
		environment: "node",
		include: ["**/*.test.ts"],
		exclude: ["node_modules/**", ".next/**"],
	},
});
