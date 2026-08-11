import path from "node:path";
import type { NextConfig } from "next";

// __dirname (not import.meta.url) is correct here: this project's
// moduleResolution: "nodenext" + no "type": "module" in dashboard/package.json
// means next.config.ts compiles to CommonJS, where `import.meta` is a hard
// TS1470 error, not just unreliable. Verified directly (not assumed) — a
// prior attempt to "fix" this to fileURLToPath(import.meta.url) failed
// typecheck for exactly this reason.
const nextConfig: NextConfig = {
	outputFileTracingRoot: path.join(__dirname, ".."),
};

export default nextConfig;
