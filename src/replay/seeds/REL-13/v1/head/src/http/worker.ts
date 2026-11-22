import { run } from "./run.js";

export const TIMEOUT_MS = 60000;

export function startBatch(jobs: string[]) {
  return jobs.map((job) => run(job, TIMEOUT_MS / 1000));
}
