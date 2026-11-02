import { beforeEach } from "vitest";
import { resetConfigForTests } from "./config/load.js";

beforeEach(() => {
	resetConfigForTests();
});
