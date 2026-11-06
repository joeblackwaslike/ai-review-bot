import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	injectConfigSection,
	renderConfigSection,
} from "../src/config/docs.js";

const target = fileURLToPath(
	new URL("../docs/configuration.md", import.meta.url),
);

writeFileSync(
	target,
	injectConfigSection(readFileSync(target, "utf8"), renderConfigSection()),
);
