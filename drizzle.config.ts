import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/improve/db/schema.ts",
	out: "./src/improve/db/migrations",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "",
	},
});
