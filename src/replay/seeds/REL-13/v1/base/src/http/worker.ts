import { run } from "./run.js";

export function startBatch(jobs: string[]) {
  return jobs.map(run);
}
