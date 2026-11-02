import { loadConfig } from "../src/config/load.js";

try {
	const { warnings } = loadConfig({ env: process.env });
	console.log(`ok (${warnings.length} warnings)`);
	for (const warning of warnings) console.log(`warning: ${warning}`);
} catch (error) {
	console.error((error as Error).message);
	process.exit(1);
}
