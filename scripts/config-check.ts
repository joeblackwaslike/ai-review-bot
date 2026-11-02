import { loadConfig } from "../src/config/load.js";

try {
	const { warnings } = loadConfig({ env: process.env });
	console.log(
		`ok (${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"})`,
	);
	for (const warning of warnings) console.log(`warning: ${warning}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
